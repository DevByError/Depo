---
title: Node.js APIs with Express or Fastify
summary: Layered services, Zod validation, error middleware, config, security middleware, Prisma or Drizzle, supertest and inject tests.
agents: backend, integration, testing, security, coder
triggers: express, fastify, node, nodejs, node.js, koa, hono, prisma, drizzle, typescript api, bun api
---
# Node.js APIs with Express or Fastify

## Layout and layers
```
src/
  app.ts            # build the app (no listen) so tests can import it
  server.ts         # read config, app.listen
  config.ts         # zod-validated environment
  routes/           # HTTP only: parse, call service, send
  services/         # business rules, throw domain errors
  repositories/     # database access (Prisma, Drizzle, Knex)
  middleware/       # auth, error handler, rate limit
  schemas/          # zod schemas shared by routes and tests
```

## Config validated at startup
```ts
import { z } from "zod";
const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  CORS_ORIGINS: z.string().default("http://localhost:5173").transform((s) => s.split(",")),
});
export const config = Env.parse(process.env); // throws with a readable list of missing variables
```

## Express 5
```ts
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";

export function buildApp(deps: Deps) {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGINS, credentials: true }));
  app.use(express.json({ limit: "100kb" }));
  app.use("/api/v1/auth", rateLimit({ windowMs: 60_000, limit: 10 }), authRouter(deps));
  app.use("/api/v1/bookings", requireAuth, bookingsRouter(deps));
  app.use(notFound);
  app.use(errorHandler); // last
  return app;
}
```
Express 5 forwards rejected promises from async handlers to the error middleware; on Express 4 wrap handlers or use express-async-errors.

Validation middleware with Zod:
```ts
export const validate =
  <T extends z.ZodTypeAny>(schema: T, where: "body" | "query" | "params" = "body") =>
  (req: Request, res: Response, next: NextFunction) => {
    const r = schema.safeParse(req[where]);
    if (!r.success) {
      throw new AppError(422, "Invalid request",
        r.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })));
    }
    res.locals[where] = r.data; // in Express 5 req.query is a getter; keep parsed data in locals
    next();
  };
```

Error middleware (one format, no stack traces to clients):
```ts
export class AppError extends Error {
  constructor(public status: number, public title: string, public errors: { field: string; message: string }[] = []) {
    super(title);
  }
}
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError)
    return res.status(err.status).type("application/problem+json").json({ title: err.title, status: err.status, errors: err.errors });
  req.log?.error({ err }, "unhandled");          // pino-http logger
  res.status(500).type("application/problem+json").json({ title: "Something went wrong", status: 500 });
}
```
Map database unique violations (Prisma `P2002`, PostgreSQL `23505`) to 409 in the repository or service.

## Fastify
```ts
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";

const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
app.register(import("@fastify/helmet"));
app.register(import("@fastify/cors"), { origin: config.CORS_ORIGINS, credentials: true });
app.register(import("@fastify/rate-limit"), { max: 100, timeWindow: "1 minute" });

app.post("/api/v1/bookings", {
  schema: { body: BookingCreate, response: { 201: BookingOut } },   // response schema strips unknown fields
  preHandler: [app.authenticate],
}, async (req, reply) => reply.code(201).send(await bookings.create(req.user, req.body)));

app.setErrorHandler((err, _req, reply) => { /* same mapping as above */ });
```
Encapsulate features as plugins (`fastify-plugin` for shared decorators); `@fastify/swagger` plus `@fastify/swagger-ui` publish the OpenAPI docs from the route schemas.

## Data access
- Prisma: `schema.prisma`, `npx prisma migrate dev --name init`, `npx prisma db seed`; use `select` or `include` deliberately (avoid N+1 and over-fetching), `prisma.$transaction([...])` for multi-writes.
- Drizzle: schema in TypeScript, `drizzle-kit generate` then `drizzle-kit migrate`; parameterised by design.
- Raw `pg`: always `pool.query("select * from users where email = $1", [email])`.

## Security middleware checklist
helmet (headers), cors with explicit origins, body size limits, rate limiting on auth and expensive routes, `app.disable("x-powered-by")` (helmet does it), cookie options `{ httpOnly: true, secure: true, sameSite: "lax" }`, never log `req.headers.authorization` or bodies with passwords (pino `redact` option).

## Tests
```ts
import request from "supertest";
const app = buildApp(testDeps);
it("rejects an invalid booking", async () => {
  const res = await request(app).post("/api/v1/bookings").set("Authorization", `Bearer ${token}`).send({});
  expect(res.status).toBe(422);
  expect(res.body.errors[0].field).toBe("doctorId");
});
```
Fastify: `await app.inject({ method: "POST", url: "/api/v1/bookings", payload: {} })`. Use Vitest or Jest (or `bun test`), a test database per run, and reset tables between tests.
