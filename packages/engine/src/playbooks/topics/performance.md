---
title: Performance: measure, then fix the biggest cost
summary: Finding N+1 queries, indexes, pagination, caching layers, compression, frontend bundles, images, Core Web Vitals, load tests and reporting.
agents: enhancement, backend, frontend, database, coder
triggers: performance, slow, speed, fast, latency, optimize, optimise, optimization, cache, caching, bundle, lighthouse, load test, k6, scalability, n+1
---
# Performance: measure, then fix the biggest cost

## 1. Measure first
| What | How |
|---|---|
| Endpoint latency | `curl -w "%{time_total}\n" -o /dev/null -s URL` a few times, or k6 for p50/p95 under load |
| Queries per request | SQL echo/logging (`echo=True`, Prisma `log: ["query"]`, Django debug toolbar), or a test asserting the query count |
| Query cost | `EXPLAIN (ANALYZE, BUFFERS)` in PostgreSQL, `.explain("executionStats")` in MongoDB |
| Python hotspots | `py-spy top --pid <pid>` or `python -m cProfile -s cumtime` |
| Node hotspots | `node --cpu-prof`, clinic.js |
| Frontend | Lighthouse (performance_check), bundle analyser (`npx vite-bundle-visualizer`, `@next/bundle-analyzer`), the browser Performance panel |
Record the before numbers in reviews/performance.md, change one thing, measure again.

## 2. Backend fixes, in order of usual payoff
- **N+1 queries**: a list of 20 bookings that loads each doctor separately makes 21 queries. Fix with eager loading: SQLAlchemy `selectinload`/`joinedload`, Django `select_related`/`prefetch_related`, Prisma `include`, TypeORM `relations`, or a DataLoader in GraphQL. Add a test that fails if the count grows with the list size.
- **Missing indexes**: sequential scans on filtered or sorted columns of big tables; add the composite index that matches the WHERE and ORDER BY (see the postgres playbook).
- **Unbounded results**: paginate every list with a capped limit; select only the columns the response needs.
- **Chatty or serial I/O**: run independent calls concurrently (`asyncio.gather`, `Promise.all`), batch writes, reuse HTTP clients and DB connection pools.
- **Heavy work in the request**: move emails, exports, image processing and AI calls to background jobs; return 202.
- **Caching**: HTTP caching for public, rarely changing data (`Cache-Control: public, max-age=300`, `ETag` with 304 responses); application caches (Redis, in-process LRU) for expensive reads with a TTL and invalidation on write; never cache private data under a shared key.
- **Compression**: gzip or brotli for JSON and assets (GZipMiddleware in FastAPI, `compression` in Express, usually the reverse proxy in production).
- **Rate limiting** protects capacity from abuse and keeps latency stable.

## 3. Frontend fixes
- **Bundle**: route-level code splitting (`lazy(() => import(...))`, Next.js does it per route), dynamic import for heavy widgets (charts, editors, maps), remove unused dependencies, import functions not whole libraries (`import debounce from "lodash/debounce"`), check the analyser for duplicates.
- **Data**: avoid waterfalls (start requests in parallel, prefetch on hover or in loaders), cache with TanStack Query, paginate or virtualise long lists (TanStack Virtual), debounce search input (250 to 300 ms).
- **Images**: correct size and format (AVIF or WebP), `width` and `height` to prevent layout shift, `loading="lazy"` below the fold, `fetchpriority="high"` for the hero image, `next/image` in Next.js.
- **Fonts**: self-hosted, subset, `font-display: swap`, preload the main font only.
- **Rendering**: memoise (`useMemo`, `React.memo`) only components a profile shows are slow; keep state close to where it is used; avoid re-creating large objects every render.

Core Web Vitals targets (75th percentile): LCP under 2.5 s, INP under 200 ms, CLS under 0.1. Depo's bar for key pages: Lighthouse 90+ in performance, accessibility, best practices and SEO.

## 4. Load testing with k6
```js
import http from "k6/http";
import { check, sleep } from "k6";
export const options = {
  vus: 20, duration: "30s",
  thresholds: { http_req_duration: ["p(95)<300"], http_req_failed: ["rate<0.01"] },
};
export default function () {
  const r = http.get("http://127.0.0.1:8000/api/v1/doctors?limit=20");
  check(r, { "status 200": (res) => res.status === 200 });
  sleep(1);
}
```
Run against a local build with seed data, never against systems you do not own.

## 5. Report
```
| Change | Metric | Before | After | How measured |
|---|---|---|---|---|
| selectinload on Booking.doctor | queries for GET /bookings | 21 | 2 | SQL echo, 20 items |
| index (doctor_id, starts_at) | p95 GET /doctors/7/slots | 180 ms | 12 ms | k6, 20 VUs, 30 s |
| lazy-load charts route | main bundle | 412 kB | 268 kB | vite-bundle-visualizer (gzip) |
```
Only report numbers you measured. List further proposals with expected gain, effort and risk.
