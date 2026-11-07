---
title: React with Vite
summary: Project layout, typed API client, TanStack Query v5, React Hook Form with Zod, React Router, screen states, testing with Vitest and MSW.
agents: frontend, integration, testing, coder
triggers: react, vite, spa, tanstack, react query, react router, react hook form, zustand, typescript frontend
---
# React with Vite

## Setup and layout
`npm create vite@latest web -- --template react-ts`. Turn on `strict` in tsconfig. Suggested layout:
```
src/
  main.tsx            # QueryClientProvider, RouterProvider
  api/client.ts       # fetch wrapper: base URL, credentials, error mapping
  api/bookings.ts     # typed functions per resource (or generated from OpenAPI)
  features/bookings/  # pages, components, hooks for one area
  components/ui/      # design-system components (Button, Input, Dialog...)
  lib/  styles/
```
Environment: `import.meta.env.VITE_API_URL`; only `VITE_` variables reach the browser, so never put secrets there. In development proxy the API to avoid CORS and cross-site cookies:
```ts
// vite.config.ts
export default defineConfig({ plugins: [react()], server: { proxy: { "/api": "http://127.0.0.1:8000" } } });
```

## One API client
```ts
export class ApiError extends Error {
  constructor(public status: number, public title: string, public fieldErrors: Record<string, string> = {}) { super(title); }
}
export async function api<T>(path: string, { headers, ...init }: RequestInit = {}): Promise<T> {
  const res = await fetch(`${import.meta.env.VITE_API_URL ?? ""}${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...headers },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fields = Object.fromEntries((body.errors ?? []).map((e: { field: string; message: string }) => [e.field, e.message]));
    throw new ApiError(res.status, body.title ?? "Request failed", fields);
  }
  return body as T;
}
```
Prefer generating types from the OpenAPI contract (openapi-typescript with openapi-fetch) so the client cannot drift.

## TanStack Query v5
```tsx
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } });

function useBookings(page: number) {
  return useQuery({
    queryKey: ["bookings", { page }],
    queryFn: ({ signal }) => api<Page<Booking>>(`/api/v1/bookings?limit=20&offset=${(page - 1) * 20}`, { signal }),
    placeholderData: keepPreviousData,      // no flash between pages
  });
}

function BookingsPage() {
  const [page, setPage] = useState(1);
  const q = useBookings(page);
  if (q.isPending) return <TableSkeleton rows={5} />;
  if (q.isError) return <ErrorState message={q.error.message} onRetry={() => q.refetch()} />;
  if (q.data.items.length === 0) return <EmptyState title="No bookings yet" action={<NewBookingButton />} />;
  return <BookingTable data={q.data} page={page} onPage={setPage} />;
}

const create = useMutation({
  mutationFn: (b: BookingInput) => api<Booking>("/api/v1/bookings", { method: "POST", body: JSON.stringify(b) }),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ["bookings"] }),
});
```
v5 names: `isPending` (was `isLoading`), `gcTime` (was `cacheTime`), single object argument. Put query keys in one place per feature. Use optimistic updates only with rollback in `onError`.

## Forms: React Hook Form + Zod
```tsx
const Schema = z.object({
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(8, "Use at least 8 characters."),
});
type Values = z.infer<typeof Schema>;

function LoginForm() {
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } =
    useForm<Values>({ resolver: zodResolver(Schema) });
  const onSubmit = async (v: Values) => {
    try { await login(v); }
    catch (e) {
      if (e instanceof ApiError) {
        for (const [field, message] of Object.entries(e.fieldErrors)) setError(field as keyof Values, { message });
        if (!Object.keys(e.fieldErrors).length) setError("root", { message: e.title });
      }
    }
  };
  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email}
             aria-describedby={errors.email ? "email-error" : undefined} {...register("email")} />
      {errors.email && <p id="email-error" role="alert">{errors.email.message}</p>}
      {/* password field the same way, autoComplete="current-password" */}
      {errors.root && <p role="alert">{errors.root.message}</p>}
      <button type="submit" disabled={isSubmitting}>{isSubmitting ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
```
`zodResolver` comes from `@hookform/resolvers/zod`. Share the Zod schema with the API types when both are TypeScript.

## Routing (React Router 7 data mode)
```tsx
const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { element: <RequireAuth />, errorElement: <RouteError />, children: [
      { path: "/", element: <Dashboard /> },
      { path: "/bookings", lazy: () => import("./features/bookings/route") },   // code-split
      { path: "/admin", element: <RequirePermission permission="users:manage" />, children: [...] },
  ] },
]);
```
`RequireAuth` reads the current user (a `useQuery(["me"])`) and redirects to /login with the return path. Hiding admin links is cosmetic: the API must still return 403.

## State
Server data lives in TanStack Query; URL state (filters, page, tab) in search params so links and the back button work; small global UI state in context or Zustand. Avoid copying server data into local state.

## Testing
Vitest + Testing Library + MSW:
```ts
server.use(http.get("/api/v1/bookings", () => HttpResponse.json({ items: [], total: 0, limit: 20, offset: 0 })));
render(<BookingsPage />, { wrapper: Providers });
expect(await screen.findByText("No bookings yet")).toBeVisible();
```
Query by role and label (`getByRole("button", { name: "Sign in" })`), test each screen state, and cover the main flow end to end with Playwright.
