---
title: Next.js App Router
summary: Server and client components, data fetching and caching, server actions with validation, route handlers, auth checks, metadata, file conventions.
agents: frontend, backend, integration, enhancement, testing, coder
triggers: next.js, nextjs, app router, server components, server actions, vercel
---
# Next.js App Router

Check the installed version in package.json first: Next.js 15 made request APIs async and stopped caching `fetch` by default; Next.js 16 renamed `middleware.ts` to `proxy.ts` and added Cache Components (`"use cache"`). Follow the version the project has.

## File conventions
```
app/
  layout.tsx            # root layout: <html lang>, fonts, providers
  page.tsx              # /
  loading.tsx           # instant loading UI (Suspense boundary) for the segment
  error.tsx             # "use client"; error boundary with a retry button (reset())
  not-found.tsx
  (dashboard)/bookings/page.tsx        # route groups do not change the URL
  bookings/[id]/page.tsx
  api/bookings/route.ts                # route handlers (GET, POST...)
lib/  components/  server/ (data access, server-only)
```

## Server components by default
Pages and layouts are server components: they can be `async`, read the database or call the API directly, and ship no JavaScript. Add `"use client"` only to leaf components that need state, effects, event handlers or browser APIs. Pass serialisable props from server to client components. Mark data modules with `import "server-only"` so they can never be bundled for the browser.

```tsx
// app/bookings/page.tsx
export default async function BookingsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page = "1" } = await searchParams;        // params and searchParams are Promises in 15+
  const session = await getSession();               // read cookies() on the server (async in 15+)
  if (!session) redirect("/login");
  const data = await listBookings(session.userId, { page: Number(page), limit: 20 });
  if (data.items.length === 0) return <EmptyState action={<NewBookingButton />} />;
  return <BookingTable items={data.items} total={data.total} page={Number(page)} />;
}
```

## Fetching and caching
- In 15+, `fetch` is not cached unless you ask: `fetch(url, { next: { revalidate: 60, tags: ["bookings"] } })` or `cache: "force-cache"`.
- Database calls are not fetches: wrap shared reads in React `cache()` to dedupe within one request; use `unstable_cache` (15) or `"use cache"` with `cacheTag`/`cacheLife` (16 with `cacheComponents: true`) for cross-request caching.
- After a mutation call `revalidatePath("/bookings")` or `revalidateTag("bookings")`.
- Never cache per-user data in a shared cache without the user in the key.
- Start independent requests in parallel (`await Promise.all([...])`) to avoid waterfalls; stream slow parts behind `<Suspense fallback={<Skeleton />}>`.

## Server actions
Server actions are public HTTP endpoints. Validate input and check authentication and authorisation inside every action.
```ts
"use server";
const Schema = z.object({ doctorId: z.coerce.number().int(), startsAt: z.string().datetime() });

export async function createBooking(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession();
  if (!session) return { error: "Please sign in again." };
  const parsed = Schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors };
  try {
    await bookings.create(session.userId, parsed.data);
  } catch (e) {
    if (e instanceof SlotTakenError) return { fieldErrors: { startsAt: ["This time is already booked."] } };
    throw e;
  }
  revalidatePath("/bookings");
  redirect("/bookings");   // redirect throws; call it outside try/catch
}
```
In the client form use React 19 `useActionState(createBooking, initialState)` and `useFormStatus()` for a pending submit button; render `fieldErrors` next to the inputs.

## Route handlers
Use `app/api/.../route.ts` for webhooks, public JSON APIs and clients other than your pages:
```ts
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
  return Response.json(await listPublicDoctors({ limit }));
}
```
When a separate backend exists (FastAPI, NestJS), call it from server components with the base URL from a server-only environment variable, and keep the access token in an HttpOnly cookie.

## Auth checks
Do the real check close to the data (in the page, action or data function), not only in middleware/proxy. Middleware/proxy is for cheap redirects (no session cookie: go to /login), not for authorisation. Libraries: Auth.js (NextAuth v5) or your backend's sessions.

## Metadata and SEO
```ts
export const metadata: Metadata = { title: { default: "Clinic", template: "%s | Clinic" }, description: "Book appointments online." };
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: (await getDoctor(id)).name };
}
```
Add `app/sitemap.ts` and `app/robots.ts` for public sites.

## Assets and performance
`next/font` self-hosts fonts (no request to Google at runtime); `next/image` with width and height (or `fill` plus `sizes`); `next/dynamic` for heavy client-only parts. Only variables prefixed `NEXT_PUBLIC_` reach the browser: never put secrets there.

## Testing
Unit-test components with Vitest and Testing Library; test server actions and data functions as plain functions; cover the main flow with Playwright against `next build && next start`.
