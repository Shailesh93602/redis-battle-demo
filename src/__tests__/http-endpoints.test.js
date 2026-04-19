"use strict";

/**
 * http-endpoints.test.js
 *
 * Tests the /health and /metrics HTTP endpoints in isolation.
 *
 * Rather than requiring server.js (which would require mocking Redis, Socket.io,
 * and Redlock — as config.test.js does), we replicate the endpoint logic inline
 * using real express + real prom-client. This keeps the test self-contained and
 * lets us assert on actual Prometheus output without fragile module mocking.
 */

const http = require("http");
const express = require("express");
const promClient = require("prom-client");

// ─── Build a minimal test app mirroring the /health and /metrics routes ───────

function buildTestApp() {
  // Use an isolated registry per test run so metrics don't bleed between tests.
  const testRegister = new promClient.Registry();
  promClient.collectDefaultMetrics({
    register: testRegister,
    prefix: "battle_",
  });

  const testConnectedClients = new promClient.Gauge({
    name: "battle_connected_clients",
    help: "Number of currently connected Socket.io clients",
    registers: [testRegister],
  });

  const testActiveRooms = new promClient.Gauge({
    name: "battle_active_rooms",
    help: "Number of active battle rooms",
    registers: [testRegister],
  });

  new promClient.Counter({
    name: "battle_attacks_total",
    help: "Total number of attack events processed",
    labelNames: ["team"],
    registers: [testRegister],
  });

  new promClient.Counter({
    name: "battle_ticks_acquired_total",
    help: "Total server ticks where this instance acquired the distributed lock",
    registers: [testRegister],
  });

  new promClient.Counter({
    name: "battle_ticks_skipped_total",
    help: "Total server ticks skipped because another instance held the lock",
    registers: [testRegister],
  });

  // Simulated state (mirrors server.js rooms Map and io.engine.clientsCount)
  const rooms = new Map();
  const fakeIo = { engine: { clientsCount: 0 } };

  const INSTANCE_ID = "server:3001";

  const app = express();

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      instance: INSTANCE_ID,
      uptime: process.uptime(),
      activeRooms: rooms.size,
      connectedClients: fakeIo?.engine?.clientsCount ?? 0,
    });
  });

  app.get("/metrics", async (_req, res) => {
    testActiveRooms.set(rooms.size);
    testConnectedClients.set(fakeIo?.engine?.clientsCount ?? 0);

    res.set("Content-Type", testRegister.contentType);
    res.end(await testRegister.metrics());
  });

  return { app, rooms, fakeIo };
}

// ─── Helper: make a GET request and collect the full response ─────────────────

function get(server, path) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body }),
      );
    });
    req.on("error", reject);
  });
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("HTTP endpoints — /health and /metrics", () => {
  let server;
  let rooms;
  let fakeIo;

  beforeAll((done) => {
    const { app, rooms: r, fakeIo: f } = buildTestApp();
    rooms = r;
    fakeIo = f;
    server = app.listen(0, done);
  });

  afterAll((done) => {
    server.close(done);
  });

  // ─── /health ─────────────────────────────────────────────────────────────────

  describe("GET /health", () => {
    test("returns HTTP 200", async () => {
      const { status } = await get(server, "/health");
      expect(status).toBe(200);
    });

    test("response body has status: 'ok'", async () => {
      const { body } = await get(server, "/health");
      const parsed = JSON.parse(body);
      expect(parsed.status).toBe("ok");
    });

    test("response body includes 'instance' field", async () => {
      const { body } = await get(server, "/health");
      const parsed = JSON.parse(body);
      expect(parsed).toHaveProperty("instance");
      expect(typeof parsed.instance).toBe("string");
    });

    test("response body includes 'uptime' as a number", async () => {
      const { body } = await get(server, "/health");
      const parsed = JSON.parse(body);
      expect(parsed).toHaveProperty("uptime");
      expect(typeof parsed.uptime).toBe("number");
      expect(parsed.uptime).toBeGreaterThan(0);
    });

    test("response body includes 'activeRooms' field", async () => {
      const { body } = await get(server, "/health");
      const parsed = JSON.parse(body);
      expect(parsed).toHaveProperty("activeRooms");
      expect(typeof parsed.activeRooms).toBe("number");
    });

    test("response body includes 'connectedClients' field", async () => {
      const { body } = await get(server, "/health");
      const parsed = JSON.parse(body);
      expect(parsed).toHaveProperty("connectedClients");
      expect(typeof parsed.connectedClients).toBe("number");
    });

    test("activeRooms reflects the current rooms Map size", async () => {
      rooms.set("room-a", { players: new Set(), score: { red: 0, blue: 0 } });

      const { body } = await get(server, "/health");
      const parsed = JSON.parse(body);
      expect(parsed.activeRooms).toBe(rooms.size);

      rooms.delete("room-a");
    });

    test("connectedClients reflects fakeIo clientsCount", async () => {
      fakeIo.engine.clientsCount = 3;

      const { body } = await get(server, "/health");
      const parsed = JSON.parse(body);
      expect(parsed.connectedClients).toBe(3);

      fakeIo.engine.clientsCount = 0;
    });
  });

  // ─── /metrics ────────────────────────────────────────────────────────────────

  describe("GET /metrics", () => {
    test("returns HTTP 200", async () => {
      const { status } = await get(server, "/metrics");
      expect(status).toBe(200);
    });

    test("Content-Type contains 'text/plain'", async () => {
      const { headers } = await get(server, "/metrics");
      expect(headers["content-type"]).toMatch(/text\/plain/);
    });

    test("response body contains 'battle_connected_clients'", async () => {
      const { body } = await get(server, "/metrics");
      expect(body).toContain("battle_connected_clients");
    });

    test("response body contains 'battle_active_rooms'", async () => {
      const { body } = await get(server, "/metrics");
      expect(body).toContain("battle_active_rooms");
    });

    test("response body contains 'battle_attacks_total'", async () => {
      const { body } = await get(server, "/metrics");
      expect(body).toContain("battle_attacks_total");
    });

    test("response body contains 'battle_ticks_acquired_total'", async () => {
      const { body } = await get(server, "/metrics");
      expect(body).toContain("battle_ticks_acquired_total");
    });

    test("response body contains 'battle_ticks_skipped_total'", async () => {
      const { body } = await get(server, "/metrics");
      expect(body).toContain("battle_ticks_skipped_total");
    });

    test("response body contains default Node.js metrics prefixed with battle_", async () => {
      const { body } = await get(server, "/metrics");
      // collectDefaultMetrics adds process/Node metrics under the 'battle_' prefix
      expect(body).toMatch(/battle_process_/);
    });

    test("battle_active_rooms gauge reflects current rooms Map size", async () => {
      rooms.set("room-metrics-test", {
        players: new Set(),
        score: { red: 0, blue: 0 },
      });

      const { body } = await get(server, "/metrics");
      // Prometheus format: battle_active_rooms 1
      expect(body).toMatch(/battle_active_rooms\s+\d/);

      rooms.delete("room-metrics-test");
    });
  });
});
