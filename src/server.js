/**
 * redis-battle-demo — server.js
 *
 * Demonstrates two key distributed-systems patterns used in EduScale:
 *
 *  1. @socket.io/redis-adapter  — broadcasts Socket.io events across N server
 *     instances, so a message emitted on instance A reaches clients connected
 *     to instances B and C.
 *
 *  2. Redlock (distributed mutex) — prevents duplicate work when multiple
 *     server instances race to process the same battle-round tick.
 *     Only one instance wins the lock; the others skip their tick.
 *
 * Quick start:
 *   docker compose up          # start Redis
 *   PORT=3001 node src/server.js &
 *   PORT=3002 node src/server.js &
 *   open http://localhost:3001
 */

"use strict";

const http = require("http");
const path = require("path");
const express = require("express");
const { Server } = require("socket.io");
const { createClient } = require("ioredis");
const { createAdapter } = require("@socket.io/redis-adapter");
const Redlock = require("redlock").default ?? require("redlock");
const promClient = require("prom-client");

// ─── Metrics ─────────────────────────────────────────────────────────────────

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register, prefix: "battle_" });

const connectedClients = new promClient.Gauge({
  name: "battle_connected_clients",
  help: "Number of currently connected Socket.io clients",
  registers: [register],
});

const activeRooms = new promClient.Gauge({
  name: "battle_active_rooms",
  help: "Number of active battle rooms",
  registers: [register],
});

const attacksTotal = new promClient.Counter({
  name: "battle_attacks_total",
  help: "Total number of attack events processed",
  labelNames: ["team"],
  registers: [register],
});

const ticksAcquired = new promClient.Counter({
  name: "battle_ticks_acquired_total",
  help: "Total server ticks where this instance acquired the distributed lock",
  registers: [register],
});

const ticksSkipped = new promClient.Counter({
  name: "battle_ticks_skipped_total",
  help: "Total server ticks skipped because another instance held the lock",
  registers: [register],
});

// ─── Config ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// Each instance gets a label so the demo UI can show which server handled a tick.
const INSTANCE_ID = `server:${PORT}`;

// Lock key — all instances race for this every TICK_INTERVAL ms.
const TICK_LOCK_KEY = "battle:tick:lock";
const TICK_INTERVAL_MS = 2000;   // how often a tick is attempted
const LOCK_TTL_MS = 1500;        // lock held for at most this long

// ─── Redis clients ───────────────────────────────────────────────────────────
// Socket.io adapter needs two separate clients: one for pub, one for sub.

const pubClient = createClient(REDIS_URL);
const subClient = pubClient.duplicate();

pubClient.on("error", (err) => console.error(`[${INSTANCE_ID}] Redis pub error:`, err.message));
subClient.on("error", (err) => console.error(`[${INSTANCE_ID}] Redis sub error:`, err.message));

// ─── Redlock ─────────────────────────────────────────────────────────────────

const redlock = new Redlock([pubClient], {
  retryCount: 0,         // don't queue — if another instance has the lock, skip
  retryDelay: 0,
  driftFactor: 0.01,
});

// ─── Express + Socket.io ─────────────────────────────────────────────────────

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: "*" },
});

// Wire up the Redis adapter — this is the single line that makes all instances
// share the same Socket.io namespace.
io.adapter(createAdapter(pubClient, subClient));

// Serve the demo UI
app.use(express.static(path.join(__dirname, "../public")));

// ─── HTTP endpoints ──────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    instance: INSTANCE_ID,
    uptime: process.uptime(),
    activeRooms: rooms.size,
    connectedClients: io?.engine?.clientsCount ?? 0,
  });
});

app.get("/metrics", async (_req, res) => {
  // Update gauges with live values
  activeRooms.set(rooms.size);
  connectedClients.set(io?.engine?.clientsCount ?? 0);

  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// ─── Game state (per-process) ─────────────────────────────────────────────────
// In a real app this lives in Redis; here we keep it simple.

const rooms = new Map(); // roomId → { players: Set<socketId>, score: { red: 0, blue: 0 } }

// ─── Socket.io handlers ───────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`[${INSTANCE_ID}] connected: ${socket.id}`);

  socket.on("join_room", (roomId) => {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, { players: new Set(), score: { red: 0, blue: 0 } });
    }
    const room = rooms.get(roomId);
    room.players.add(socket.id);
    socket.join(roomId);

    // Because we use the Redis adapter, this emit reaches clients on ALL instances.
    io.to(roomId).emit("room_update", {
      roomId,
      playerCount: room.players.size,
      score: room.score,
      handledBy: INSTANCE_ID,
    });

    console.log(`[${INSTANCE_ID}] ${socket.id} joined room ${roomId} (${room.players.size} players)`);
  });

  socket.on("attack", ({ roomId, team }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (team === "red") room.score.red += 10;
    if (team === "blue") room.score.blue += 10;

    attacksTotal.inc({ team: team ?? "unknown" });

    io.to(roomId).emit("score_update", {
      score: room.score,
      by: socket.id,
      handledBy: INSTANCE_ID,
    });
  });

  socket.on("disconnecting", () => {
    for (const roomId of socket.rooms) {
      const room = rooms.get(roomId);
      if (!room) continue;
      room.players.delete(socket.id);
      io.to(roomId).emit("room_update", {
        roomId,
        playerCount: room.players.size,
        score: room.score,
        handledBy: INSTANCE_ID,
      });
    }
  });

  socket.on("disconnect", () => {
    console.log(`[${INSTANCE_ID}] disconnected: ${socket.id}`);
  });
});

// ─── Distributed tick (Redlock) ───────────────────────────────────────────────
// Every TICK_INTERVAL_MS, each server instance tries to acquire a distributed
// lock. Only the winner runs the tick logic — the others skip silently.
// This prevents double-processing without a central coordinator.

async function tryTick() {
  let lock;
  try {
    lock = await redlock.acquire([TICK_LOCK_KEY], LOCK_TTL_MS);
    ticksAcquired.inc();
  } catch {
    // Another instance holds the lock — this is normal, not an error.
    ticksSkipped.inc();
    return;
  }

  try {
    // Only one instance reaches here per tick window.
    const timestamp = new Date().toISOString();
    console.log(`[${INSTANCE_ID}] ✓ tick lock acquired at ${timestamp}`);

    // Broadcast the tick event to ALL connected clients across ALL instances.
    io.emit("server_tick", { at: timestamp, by: INSTANCE_ID });
  } finally {
    await lock.release();
  }
}

setInterval(tryTick, TICK_INTERVAL_MS);

// ─── Boot ─────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`[${INSTANCE_ID}] listening on http://localhost:${PORT}`);
  console.log(`[${INSTANCE_ID}] Redis: ${REDIS_URL}`);
});
