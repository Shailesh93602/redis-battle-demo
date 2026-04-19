# redis-battle-demo

Reference implementation for two distributed-systems patterns used in [EduScale](https://github.com/Shailesh93602/eduscale):

| Pattern                  | Library                    | What it solves                                                |
| ------------------------ | -------------------------- | ------------------------------------------------------------- |
| Multi-instance Socket.io | `@socket.io/redis-adapter` | Events emitted on instance A reach clients on instances B, C  |
| Distributed mutex        | `redlock`                  | Only one instance runs a periodic tick — no double processing |

## Architecture

```
Browser A ──┐                         ┌── Browser C
            │                         │
       ┌────▼────────────────────────▼────┐
       │  Node instance :3001             │  Node instance :3002
       │  io.adapter(redisAdapter)        │  io.adapter(redisAdapter)
       └────────────┬────────────────────-┘
                    │   pub/sub channels
              ┌─────▼─────┐
              │   Redis   │  ← single source of truth for events
              └─────┬─────┘
                    │   redlock key: "battle:tick:lock"
              only ONE instance wins the lock per tick window
```

**What happens without the Redis adapter:**

- Browser A connects to instance :3001
- Browser C connects to instance :3002
- A's attack event is only broadcast to clients on :3001 — C never sees it

**What happens without Redlock:**

- Both :3001 and :3002 fire their `setInterval` tick at ~the same time
- Both emit `server_tick` → clients get duplicate events, scores double-count

## Quick start

```bash
# 1. Start Redis
docker compose up -d

# 2. Start two server instances in separate terminals
PORT=3001 node src/server.js
PORT=3002 node src/server.js

# 3. Open both in browser
open http://localhost:3001
open http://localhost:3002

# Join the same room on both tabs, attack from one —
# watch the score update on both tabs even though they
# hit different servers. Watch the tick log show only
# one server per 2-second window (Redlock at work).
```

## Environment variables

| Variable    | Default                  | Description                 |
| ----------- | ------------------------ | --------------------------- |
| `PORT`      | `3001`                   | HTTP port for this instance |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string     |

## Running tests

```bash
# Unit + integration tests (no Redis required — all I/O is mocked or in-process)
npm test

# With coverage report
npm run test:coverage
```

All three test suites run without a live Redis server:

| Suite                   | What it tests                                                                 |
| ----------------------- | ----------------------------------------------------------------------------- |
| `config.test.js`        | Module loads correctly, env-var parsing, adapter wiring                       |
| `redlock.test.js`       | `tryTick` acquires lock → emits `server_tick`; skips when lock held           |
| `socket-events.test.js` | `join_room`, `attack`, `disconnecting` handlers via real in-process Socket.io |

## Key code sections

### Redis adapter — why two separate clients?

```js
// src/server.js
const pubClient = createClient(REDIS_URL);
const subClient = pubClient.duplicate(); // <-- must be a separate connection
io.adapter(createAdapter(pubClient, subClient));
```

Redis pub/sub requires a dedicated connection for the subscriber: once a client
issues `SUBSCRIBE` it enters subscriber mode and can no longer send regular
commands (like `PUBLISH`). The adapter therefore needs **two** connections —
one that stays in subscriber mode to receive broadcasts, and one that stays
free to publish and run other commands.

### Redlock — why `retryCount: 0`?

Setting `retryCount: 0` means: if the lock is already held by another instance,
throw immediately instead of queuing and retrying. The calling instance then
returns early (`tryTick` catches the error and returns). This is intentional
for a periodic tick — it is better to **skip** a tick than to pile up queued
lock attempts that would fire in a burst once the previous lock releases.

```js
const redlock = new Redlock([pubClient], { retryCount: 0 });

async function tryTick() {
  let lock;
  try {
    lock = await redlock.acquire(["battle:tick:lock"], 1500);
  } catch {
    return; // another instance holds the lock
  }
  try {
    io.emit("server_tick", { at: new Date().toISOString(), by: INSTANCE_ID });
  } finally {
    await lock.release();
  }
}
setInterval(tryTick, 2000);
```

## Metrics & Observability

GET /health — JSON health check with live room and client counts
GET /metrics — Prometheus metrics (text/plain; version=0.0.4)

Tracked metrics:
| Metric | Type | Description |
|--------|------|-------------|
| battle_connected_clients | Gauge | Live Socket.io client count |
| battle_active_rooms | Gauge | Battle rooms with ≥1 player |
| battle_attacks_total{team} | Counter | Attack events by team |
| battle_ticks_acquired_total | Counter | Ticks where this instance won the lock |
| battle_ticks_skipped_total | Counter | Ticks skipped (lock held by another instance) |

These metrics expose the distributed-lock behavior directly: in a two-instance setup,
ticks_acquired + ticks_skipped across both instances should equal the total tick count.

## Related

- [EduScale architecture blog post](https://shaileshchaudhari.vercel.app/blog/eduscale-distributed-architecture) _(coming soon)_
- [`@socket.io/redis-adapter` docs](https://socket.io/docs/v4/redis-adapter/)
- [Redlock algorithm](https://redis.io/docs/manual/patterns/distributed-locks/)
