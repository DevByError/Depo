---
title: Redis for caching, rate limits, sessions and queues
summary: Cache-aside with TTL and invalidation, key design, stampede protection, rate limiting, sessions, background jobs, local setup.
agents: backend, enhancement, database, security, coder
triggers: redis, valkey, cache, caching, rate limit, rate limiting, queue, queues, background jobs, celery, bullmq, rq, arq, pub/sub
---
# Redis for caching, rate limits, sessions and queues

Redis is a fast, in-memory helper. Keep the source of truth in the database; anything in Redis must be safe to lose or rebuild.

## Key design
- Namespaced, readable keys: `clinic:v1:doctor:42`, `clinic:v1:doctors:list:page=1:limit=20`, `rl:login:ip:203.0.113.5`.
- Include everything that changes the answer in the key, especially the user or tenant for private data (`clinic:v1:user:7:bookings:page=1`).
- Bump the version segment (`v1` to `v2`) to drop a whole family after a format change.
- Always set a TTL on cache keys.

## Cache-aside
```python
import json
from redis.asyncio import Redis

redis = Redis.from_url(settings.redis_url, decode_responses=True)

async def get_doctor(doctor_id: int) -> dict:
    key = f"clinic:v1:doctor:{doctor_id}"
    if (hit := await redis.get(key)) is not None:
        return json.loads(hit)
    doctor = await repo.get_doctor(doctor_id)              # source of truth
    await redis.set(key, json.dumps(doctor), ex=300)       # 5 min TTL
    return doctor

async def update_doctor(doctor_id: int, data: dict) -> None:
    await repo.update_doctor(doctor_id, data)
    await redis.delete(f"clinic:v1:doctor:{doctor_id}")    # invalidate after the write commits
```
Node: `import { createClient } from "redis"` (node-redis) or `ioredis`; same pattern with `get`, `set(key, value, { EX: 300 })`, `del`.

- Invalidate on every write path, or accept bounded staleness with a short TTL and say so in decisions.md.
- Lists and search results are hard to invalidate precisely: cache them briefly (30 to 60 s) or use a version counter key (`INCR clinic:v1:doctors:ver` on any change and include it in list keys).
- Stampede protection for expensive keys: add jitter to TTLs, and let one caller rebuild (`SET lock:key 1 NX EX 10`) while others serve the stale value or wait briefly.
- Measure hit rate and latency before and after; a cache that is rarely hit only adds complexity.

## Rate limiting
Fixed window (simple, good for login):
```python
async def allow(key: str, limit: int, window_s: int) -> bool:
    n = await redis.incr(key)
    if n == 1:
        await redis.expire(key, window_s)
    return n <= limit
# allow(f"rl:login:{ip}", 10, 60) and allow(f"rl:login:{email}", 5, 300); answer 429 with Retry-After
```
Sliding windows use a sorted set per key (`ZADD` now, `ZREMRANGEBYSCORE` older than the window, `ZCARD`) inside a `MULTI` or Lua script. Framework options: express-rate-limit with rate-limit-redis, @fastify/rate-limit with Redis, slowapi or fastapi-limiter for FastAPI, DRF throttling with a Redis cache.

## Sessions
Server-side sessions: random 32-byte session id in an HttpOnly cookie, data at `sess:<id>` with a TTL that is refreshed on activity (idle timeout) plus an absolute expiry stored inside. Delete the key on logout; delete all of a user's sessions on password change (keep a set `user:7:sessions`).

## Background jobs
Do slow work (emails, exports, image processing, AI calls) outside the request:
- Node: BullMQ (`new Queue("emails")`, `new Worker("emails", handler)`), with retries, backoff and a dead-letter view.
- Python: arq (async), RQ (simple) or Celery (feature-rich) with Redis as the broker.
Jobs must be idempotent (safe to run twice) and carry ids, not whole objects. Return 202 with a job id and let the client poll or receive an event.

## Pub/sub and streams
Pub/sub is fire-and-forget (fine for live UI notifications across API instances). Use Redis Streams or a queue when messages must not be lost.

## Local setup and safety
docker compose service `redis:7-alpine` (or `valkey/valkey:8-alpine`) bound to `127.0.0.1:6379`, with `command: ["redis-server", "--appendonly", "yes"]` if data should survive restarts. On Windows without Docker, Memurai or WSL provide a Redis-compatible server. Never expose Redis to the network without a password and TLS; set `maxmemory` with an eviction policy (`allkeys-lru`) for pure caches. Tests use a separate database number or a fake (fakeredis for Python, ioredis-mock for Node).
