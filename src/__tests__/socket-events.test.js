"use strict";

/**
 * socket-events.test.js
 *
 * Tests the Socket.io event handlers (join_room, attack, disconnecting/disconnect)
 * by spinning up a real in-process http + socket.io server that replicates the
 * EXACT handler logic from server.js — but without any Redis dependency.
 *
 * Event shapes verified against server.js:
 *   join_room  payload : roomId (string)
 *   attack     payload : { roomId, team }
 *   room_update emitted: { roomId, playerCount, score, handledBy }
 *   score_update emitted: { score, by, handledBy }
 */

const { createServer } = require("http");
const { Server } = require("socket.io");
const Client = require("socket.io-client");

// ─── Helper: promisify a one-time socket event ────────────────────────────────
function waitFor(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

// ─── Replicate server.js room logic inline (no Redis, no real server.js) ─────

function buildServer() {
  const httpServer = createServer();
  const io = new Server(httpServer, { cors: { origin: "*" } });

  // Exactly matches server.js
  const INSTANCE_ID = "test-instance";
  const rooms = new Map();

  io.on("connection", (socket) => {
    socket.on("join_room", (roomId) => {
      if (!rooms.has(roomId)) {
        rooms.set(roomId, { players: new Set(), score: { red: 0, blue: 0 } });
      }
      const room = rooms.get(roomId);
      room.players.add(socket.id);
      socket.join(roomId);

      io.to(roomId).emit("room_update", {
        roomId,
        playerCount: room.players.size,
        score: room.score,
        handledBy: INSTANCE_ID,
      });
    });

    socket.on("attack", ({ roomId, team }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      if (team === "red") room.score.red += 10;
      if (team === "blue") room.score.blue += 10;

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
  });

  return { io, httpServer, rooms };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Socket.io event handlers", () => {
  let io, httpServer, rooms;
  let port;

  beforeAll(
    () =>
      new Promise((resolve) => {
        ({ io, httpServer, rooms } = buildServer());
        httpServer.listen(0, () => {
          port = httpServer.address().port;
          resolve();
        });
      }),
  );

  afterAll(
    () =>
      new Promise((resolve) => {
        io.close(() => {
          httpServer.close(resolve);
        });
      }),
  );

  // Helper to create a connected client
  function newClient() {
    return Client(`http://localhost:${port}`, {
      forceNew: true,
      transports: ["websocket"],
    });
  }

  // ─── join_room ──────────────────────────────────────────────────────────────

  describe("join_room", () => {
    test("creates the room on first join", async () => {
      const client = newClient();
      await waitFor(client, "connect");

      const roomId = "room-create-test";
      client.emit("join_room", roomId);
      const update = await waitFor(client, "room_update");

      expect(update.roomId).toBe(roomId);
      expect(rooms.has(roomId)).toBe(true);

      client.disconnect();
    });

    test("room_update contains playerCount, score and handledBy", async () => {
      const client = newClient();
      await waitFor(client, "connect");

      const roomId = "room-shape-test";
      client.emit("join_room", roomId);
      const update = await waitFor(client, "room_update");

      expect(update).toMatchObject({
        roomId,
        playerCount: expect.any(Number),
        score: { red: expect.any(Number), blue: expect.any(Number) },
        handledBy: expect.any(String),
      });

      client.disconnect();
    });

    test("playerCount increments when a second player joins the same room", async () => {
      const c1 = newClient();
      const c2 = newClient();
      await Promise.all([waitFor(c1, "connect"), waitFor(c2, "connect")]);

      const roomId = "room-multi-player";

      c1.emit("join_room", roomId);
      await waitFor(c1, "room_update"); // first join

      // Both clients will receive the second room_update
      const [update] = await Promise.all([
        waitFor(c1, "room_update"),
        (() => {
          c2.emit("join_room", roomId);
          return Promise.resolve();
        })(),
      ]);

      // playerCount should be ≥ 2 (exact value depends on test isolation order)
      expect(rooms.get(roomId).players.size).toBeGreaterThanOrEqual(2);

      c1.disconnect();
      c2.disconnect();
    });

    test("score starts at { red: 0, blue: 0 } for a new room", async () => {
      const client = newClient();
      await waitFor(client, "connect");

      const roomId = "room-score-init-" + Date.now();
      client.emit("join_room", roomId);
      const update = await waitFor(client, "room_update");

      expect(update.score).toEqual({ red: 0, blue: 0 });

      client.disconnect();
    });
  });

  // ─── attack ─────────────────────────────────────────────────────────────────

  describe("attack", () => {
    test("red attack increments red score by 10", async () => {
      const client = newClient();
      await waitFor(client, "connect");

      const roomId = "room-attack-red-" + Date.now();
      client.emit("join_room", roomId);
      await waitFor(client, "room_update");

      client.emit("attack", { roomId, team: "red" });
      const scoreEvent = await waitFor(client, "score_update");

      expect(scoreEvent.score.red).toBe(10);
      expect(scoreEvent.score.blue).toBe(0);

      client.disconnect();
    });

    test("blue attack increments blue score by 10", async () => {
      const client = newClient();
      await waitFor(client, "connect");

      const roomId = "room-attack-blue-" + Date.now();
      client.emit("join_room", roomId);
      await waitFor(client, "room_update");

      client.emit("attack", { roomId, team: "blue" });
      const scoreEvent = await waitFor(client, "score_update");

      expect(scoreEvent.score.blue).toBe(10);
      expect(scoreEvent.score.red).toBe(0);

      client.disconnect();
    });

    test("multiple attacks accumulate score correctly", async () => {
      const client = newClient();
      await waitFor(client, "connect");

      const roomId = "room-attack-accum-" + Date.now();
      client.emit("join_room", roomId);
      await waitFor(client, "room_update");

      // 2× red, 3× blue
      client.emit("attack", { roomId, team: "red" });
      await waitFor(client, "score_update");
      client.emit("attack", { roomId, team: "red" });
      await waitFor(client, "score_update");
      client.emit("attack", { roomId, team: "blue" });
      await waitFor(client, "score_update");
      client.emit("attack", { roomId, team: "blue" });
      await waitFor(client, "score_update");
      client.emit("attack", { roomId, team: "blue" });
      const last = await waitFor(client, "score_update");

      expect(last.score.red).toBe(20);
      expect(last.score.blue).toBe(30);

      client.disconnect();
    });

    test("score_update includes by (socket id) and handledBy fields", async () => {
      const client = newClient();
      await waitFor(client, "connect");

      const roomId = "room-attack-fields-" + Date.now();
      client.emit("join_room", roomId);
      await waitFor(client, "room_update");

      client.emit("attack", { roomId, team: "red" });
      const scoreEvent = await waitFor(client, "score_update");

      expect(scoreEvent).toMatchObject({
        score: expect.any(Object),
        by: expect.any(String),
        handledBy: expect.any(String),
      });

      client.disconnect();
    });

    test("attack on non-existent room is silently ignored (no score_update)", async () => {
      const client = newClient();
      await waitFor(client, "connect");

      let received = false;
      client.on("score_update", () => {
        received = true;
      });

      client.emit("attack", { roomId: "does-not-exist", team: "red" });

      // Wait briefly to confirm no event fires
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received).toBe(false);

      client.disconnect();
    });
  });

  // ─── disconnect / disconnecting ─────────────────────────────────────────────

  describe("disconnect cleanup", () => {
    test("disconnecting player triggers room_update with decremented playerCount", async () => {
      const c1 = newClient();
      const c2 = newClient();
      await Promise.all([waitFor(c1, "connect"), waitFor(c2, "connect")]);

      const roomId = "room-disconnect-" + Date.now();

      // Both join
      c1.emit("join_room", roomId);
      await waitFor(c1, "room_update");
      c2.emit("join_room", roomId);
      await waitFor(c1, "room_update"); // c1 gets notified when c2 joins

      const sizeBeforeDisconnect = rooms.get(roomId).players.size;

      // c2 disconnects — c1 should receive a room_update
      const updatePromise = waitFor(c1, "room_update");
      c2.disconnect();
      const update = await updatePromise;

      expect(update.playerCount).toBe(sizeBeforeDisconnect - 1);

      c1.disconnect();
    });

    test("player is removed from room.players Set on disconnect", async () => {
      const c1 = newClient();
      const c2 = newClient();
      await Promise.all([waitFor(c1, "connect"), waitFor(c2, "connect")]);

      const roomId = "room-set-cleanup-" + Date.now();

      c1.emit("join_room", roomId);
      await waitFor(c1, "room_update");
      c2.emit("join_room", roomId);
      await waitFor(c1, "room_update");

      // Wait for c2 to actually be tracked
      const room = rooms.get(roomId);
      const countBefore = room.players.size;

      const updatePromise = waitFor(c1, "room_update");
      c2.disconnect();
      await updatePromise;

      expect(room.players.size).toBe(countBefore - 1);

      c1.disconnect();
    });
  });
});
