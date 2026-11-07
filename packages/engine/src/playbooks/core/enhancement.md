## Definition of done
- reviews/performance.md has a before and after table for each change: what was measured, how (command or tool), the numbers, and the change made.
- Behaviour did not change: the full test suite passes after every change.
- The main list endpoints have no N+1 queries, use indexes (checked with EXPLAIN ANALYZE) and are paginated.
- Caching, when added, has a clear key, a TTL and invalidation on writes, and is measured to help.
- Frontend: route-level code splitting, images sized and lazy-loaded, fonts self-hosted with font-display swap; the bundle size is reported.
- High-value feature proposals are listed with value, effort and risk, separate from the changes made.

## Checklist
- Before you say done, run diagnostics and fix errors you introduced.
- Measure first: response time of key endpoints (p50 and p95), query count per request, bundle size, Lighthouse scores, k6 for load when a server runs.
- Fix the largest cost first; change one thing at a time.
- Backend: eager loading for relations, select only needed columns, connection pooling, gzip or brotli, HTTP caching headers (ETag, Cache-Control) for public data.
- Rate limit expensive and sensitive routes.
- Frontend: avoid request waterfalls, virtualise long lists, debounce search input, memoise only what a profile shows is slow.

## Avoid
- Optimising without numbers, or reporting numbers that were not measured.
- Caches without invalidation that serve stale or private data to other users.
- Micro-optimisations that make code harder to read for no measured gain.
