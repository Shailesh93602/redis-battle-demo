# redis-battle-demo

Reference implementation for two distributed-systems patterns used in [EduScale](https://github.com/Shailesh93602/eduscale):

| Pattern | Library | What it solves |
|---|---|---|
| Multi-instance Socket.io | `@socket.io/redis-adapter` | Events emitted on instance A reach clients on instances B, C |
| Distributed mutex | `redlock` | Only one instance runs a periodic tick — no double processing |

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

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP port for this instance |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |

## Key code sections

### Redis adapter (3 lines)
```js
// src/server.js
const pubClient = createClient(REDIS_URL);
const subClient = pubClient.duplicate();
io.adapter(createAdapter(pubClient, subClient));
```

### Redlock tick (no retry — skip if busy)
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

## Related

- [EduScale architecture blog post](https://shaileshchaudhari.vercel.app/blog/eduscale-distributed-architecture) *(coming soon)*
- [`@socket.io/redis-adapter` docs](https://socket.io/docs/v4/redis-adapter/)
- [Redlock algorithm](https://redis.io/docs/manual/patterns/distributed-locks/)
