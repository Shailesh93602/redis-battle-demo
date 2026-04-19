# CLAUDE.md — redis-battle-demo

## Project overview

Standalone "5-minute read" demo of three distributed-systems patterns extracted from EduScale. Live at <https://redis-battle-demo.onrender.com/>.

Two Node.js instances race for a Redlock distributed lock every 2 seconds; winning instance broadcasts a "tick" event to all connected browser clients via `@socket.io/redis-adapter`. A `/metrics` endpoint exposes 5 Prometheus counters/gauges (connected clients, active rooms, attacks, ticks acquired, ticks skipped).

## Stack

Plain Node.js (no TypeScript — intentional for fastest review), Express, Socket.io, `@socket.io/redis-adapter`, `ioredis`, `redlock`, `prom-client`, Jest + supertest, Docker Compose (local Redis), ESLint + Prettier.

## Key commands

```bash
npm start                # production server on PORT (default 3000)
npm run dev              # nodemon on src/server.js
npm test                 # 48 Jest tests
npm run test:coverage
npm run lint             # ESLint (flat config)
npm run format / format:check

docker compose up -d     # starts a local Redis on 6379
```

## Architecture

```
src/
  server.js        # Express app + Socket.io server + Redis adapter + Redlock tick loop + prom-client /metrics
  config.js        # Env + Redis URL + instance naming
  __tests__/       # 48 tests — http endpoints, socket events, redlock behavior, config

public/
  index.html       # Browser UI — shows ticks as they arrive, Prometheus link, instance ID

docker-compose.yml # Redis container for local dev
railway.toml       # Old Railway deploy config — superseded by Render
```

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `REDIS_URL` | Yes | `redis://...` — Upstash on Render (free tier was paused, revived 2026-04-19) |
| `NODE_ENV` | Optional | Affects log verbosity |
| `PORT` | Optional | Default 3000; Render convention uses 10000 |
| `INSTANCE_ID` | Optional | Override auto-generated ID — useful when running 2 instances locally to see the Redlock race |

## Deployment

**Render (current):** Free tier, single instance. Limitation: the Redlock two-node race requires 2 instances — paid tier ($7/mo) or Fly.io (supports 2 free).

**Fly.io alternative (2 free instances):**

```bash
fly launch && fly redis create
fly secrets set REDIS_URL=<from fly redis>
fly deploy && fly scale count 2
```

## Upstash keepalive

Upstash Redis free tier pauses on inactivity. Kept alive via the portfolio's [url-health-check.yml](../portfolio_next/.github/workflows/url-health-check.yml) GitHub Action — daily GET on the Render URL wakes the free-tier instance, which reconnects to Upstash, which counts as activity.

If the Render service is idle for >15 min the instance spins down (cold start ~30s on next request — acceptable for a demo). If Upstash itself pauses, manual "Resume" from the Upstash dashboard is needed one time; the health check keeps it alive from then on.

## Testing

48 tests covering:
- HTTP health/metrics endpoints (supertest)
- Socket events (connect, join-room, tick broadcast)
- Redlock mutex behavior (retryCount=0 means losing instance just skips)
- Config validation

No a11y / i18n / visual regression yet. This is a backend-focused demo so a11y is lower priority, but the `public/index.html` UI should have basic ARIA.

## Owner context

- Under review in MANUAL.md §3 (demos-vs-flagship decision): if the user picks "fold into flagship," this repo gets archived and EduScale's case-study page becomes the canonical Redlock demo. If they keep it, low maintenance (one Render service, one GitHub health check).

## Related

- Parent portfolio: `/Users/shaileshchaudhari/Desktop/Coding/portfolio_next/CLAUDE.md`
- EduScale (production equivalent): `/Users/shaileshchaudhary/Desktop/Coding/EduScale/Backend/src/` uses the same patterns at larger scale.
