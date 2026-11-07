---
title: NestJS services
summary: Modules, DTOs with class-validator, global ValidationPipe, config validation, guards for auth and roles, exception filters, Swagger, testing.
agents: backend, integration, testing, security, coder
triggers: nestjs, nest.js, @nestjs, nest, typeorm
---
# NestJS services

## Structure
One module per feature (`AuthModule`, `UsersModule`, `BookingsModule`), each with a controller (HTTP only), a service (business rules) and a repository or ORM access (TypeORM, Prisma or MikroORM). Shared concerns (config, database, guards) live in their own modules. Keep controllers thin: validate, call the service, return a response DTO.

## Bootstrap
```ts
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.setGlobalPrefix("api/v1");
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  const doc = SwaggerModule.createDocument(app,
    new DocumentBuilder().setTitle("Clinic API").setVersion("1.0").addBearerAuth().build());
  SwaggerModule.setup("api/docs", app, doc);
  await app.listen(process.env.PORT ?? 3000);
}
```
`whitelist` strips unknown fields and `forbidNonWhitelisted` rejects them: this blocks mass assignment (a client sending `role: "admin"`).

## DTOs
```ts
import { IsDateString, IsInt, IsOptional, IsString, MaxLength, Min, Max } from "class-validator";
import { Type } from "class-transformer";

export class CreateBookingDto {
  @IsInt() doctorId!: number;
  @IsDateString() startsAt!: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class PageQueryDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
  @Type(() => Number) @IsInt() @Min(0) offset = 0;
}
```
Response DTOs (or `ClassSerializerInterceptor` with `@Exclude()` on `passwordHash`) make sure internal fields never leave the API.

## Config
```ts
ConfigModule.forRoot({
  isGlobal: true,
  validate: (env) => EnvSchema.parse(env),   // zod schema; or validationSchema with Joi
});
```
Inject `ConfigService` instead of reading `process.env` across the code.

## Auth and roles with guards
```ts
export const ROLES_KEY = "roles";
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required) return true;
    const { user } = ctx.switchToHttp().getRequest();
    return required.some((r) => user?.roles?.includes(r));
  }
}

@Controller("bookings")
@UseGuards(JwtAuthGuard, RolesGuard)
export class BookingsController {
  @Get() list(@Query() q: PageQueryDto, @CurrentUser() user: User) { return this.bookings.listFor(user, q); }
  @Delete(":id") @Roles(Role.Admin) remove(@Param("id", ParseIntPipe) id: number) { return this.bookings.remove(id); }
}
```
Make authentication global (`APP_GUARD` with a `@Public()` decorator for open routes) so new routes are protected by default. For fine-grained rules, check permissions (`booking:cancel`) rather than role names, and check ownership in the service. JWT: `@nestjs/jwt` with short access tokens; refresh tokens stored hashed and rotated (see the auth playbook). Rate limit with `@nestjs/throttler` (`ThrottlerModule.forRoot([{ ttl: 60000, limit: 10 }])` on auth routes).

## Errors
Throw built-in exceptions (`NotFoundException`, `ConflictException`, `ForbiddenException`) from services, or domain errors mapped by a global exception filter:
```ts
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const status = e instanceof HttpException ? e.getStatus() : 500;
    const body = e instanceof HttpException ? e.getResponse() : { message: "Something went wrong" };
    res.status(status).type("application/problem+json").json({ status, ...(typeof body === "string" ? { title: body } : body) });
  }
}
```
Translate unique violations from the ORM (TypeORM `QueryFailedError` code 23505, Prisma `P2002`) to `ConflictException`.

## Database
TypeORM: entities with `@Index`, `@Unique`, relations with `onDelete`; `synchronize: false` outside throwaway prototypes; generate migrations (`typeorm migration:generate`) and run them on start or in the run script. Prisma: a `PrismaService extends PrismaClient implements OnModuleInit`. Use transactions for multi-step writes (`dataSource.transaction(async (m) => ...)` or `prisma.$transaction`).

## Testing
```ts
const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(MailService).useValue({ send: vi.fn() })
  .compile();
const app = moduleRef.createNestApplication();
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
await app.init();
await request(app.getHttpServer()).post("/bookings").send({}).expect(400);
```
NestJS validation failures return 400 by default (not 422); keep that consistent in the contract. Unit-test services with mocked repositories; e2e-test controllers with supertest against a test database.
