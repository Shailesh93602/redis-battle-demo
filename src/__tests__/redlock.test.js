"use strict";

/**
 * redlock.test.js
 *
 * Tests the distributed tick logic from server.js in isolation.
 *
 * Constants mirrored from server.js:
 *   TICK_LOCK_KEY  = "battle:tick:lock"
 *   LOCK_TTL_MS    = 1500
 *
 * The tryTick function is replicated here with injected dependencies (mockRedlock,
 * mockIo) so we can test every code path without touching Redis or a real server.
 */

// ─── Constants (mirrored from server.js) ─────────────────────────────────────

const TICK_LOCK_KEY = "battle:tick:lock";
const LOCK_TTL_MS = 1500;
const INSTANCE_ID = "server:3001";

// ─── Factory: build a tryTick function with injected dependencies ─────────────

function makeTryTick({ redlock, io }) {
  return async function tryTick() {
    let lock;
    try {
      lock = await redlock.acquire([TICK_LOCK_KEY], LOCK_TTL_MS);
    } catch {
      // Another instance holds the lock — skip this tick.
      return;
    }

    try {
      const timestamp = new Date().toISOString();
      io.emit("server_tick", { at: timestamp, by: INSTANCE_ID });
    } finally {
      await lock.release();
    }
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Distributed tick logic (tryTick)", () => {
  let mockLock;
  let mockRedlock;
  let mockIo;
  let emittedEvents;
  let tryTick;

  beforeEach(() => {
    emittedEvents = [];
    mockLock = {
      release: jest.fn().mockResolvedValue(undefined),
    };
    mockRedlock = {
      acquire: jest.fn(),
    };
    mockIo = {
      emit: jest.fn((event, data) => {
        emittedEvents.push({ event, data });
      }),
    };
    tryTick = makeTryTick({ redlock: mockRedlock, io: mockIo });
  });

  // ─── Lock acquisition success path ─────────────────────────────────────────

  test("emits server_tick when lock is acquired", async () => {
    mockRedlock.acquire.mockResolvedValue(mockLock);
    await tryTick();
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].event).toBe("server_tick");
  });

  test("server_tick payload contains 'at' (ISO timestamp) and 'by' (instance id)", async () => {
    mockRedlock.acquire.mockResolvedValue(mockLock);
    await tryTick();
    const { data } = emittedEvents[0];
    expect(data.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(data.by).toBe(INSTANCE_ID);
  });

  test("lock is released after emitting server_tick", async () => {
    mockRedlock.acquire.mockResolvedValue(mockLock);
    await tryTick();
    expect(mockLock.release).toHaveBeenCalledTimes(1);
  });

  test("lock is released even if io.emit throws (finally block guarantees release)", async () => {
    mockRedlock.acquire.mockResolvedValue(mockLock);
    mockIo.emit.mockImplementationOnce(() => {
      throw new Error("io.emit failed");
    });

    // The tryTick try/finally propagates the error but still releases the lock.
    await expect(tryTick()).rejects.toThrow("io.emit failed");
    expect(mockLock.release).toHaveBeenCalledTimes(1);
  });

  // ─── Lock acquisition failure path ─────────────────────────────────────────

  test("does NOT emit server_tick when lock acquisition fails", async () => {
    mockRedlock.acquire.mockRejectedValue(
      new Error("Lock held by another instance")
    );
    await tryTick();
    expect(emittedEvents).toHaveLength(0);
  });

  test("does not call lock.release when lock was never acquired", async () => {
    mockRedlock.acquire.mockRejectedValue(new Error("ExecutionError"));
    await tryTick();
    expect(mockLock.release).not.toHaveBeenCalled();
  });

  test("resolves without throwing when lock acquisition fails", async () => {
    mockRedlock.acquire.mockRejectedValue(
      new Error("Lock held by another instance")
    );
    await expect(tryTick()).resolves.toBeUndefined();
  });

  // ─── Lock key and TTL ────────────────────────────────────────────────────────

  test("acquires lock with the correct key array", async () => {
    mockRedlock.acquire.mockResolvedValue(mockLock);
    await tryTick();
    expect(mockRedlock.acquire).toHaveBeenCalledWith(
      [TICK_LOCK_KEY],
      expect.any(Number)
    );
  });

  test("lock key contains 'tick' to identify its purpose", async () => {
    mockRedlock.acquire.mockResolvedValue(mockLock);
    await tryTick();
    const [keys] = mockRedlock.acquire.mock.calls[0];
    expect(keys[0]).toContain("tick");
  });

  test("lock TTL is a positive number less than TICK_INTERVAL_MS (2000ms)", async () => {
    mockRedlock.acquire.mockResolvedValue(mockLock);
    await tryTick();
    const ttl = mockRedlock.acquire.mock.calls[0][1];
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThan(2000); // must be shorter than the tick interval
  });

  test("acquire is called exactly once per tryTick invocation", async () => {
    mockRedlock.acquire.mockResolvedValue(mockLock);
    await tryTick();
    expect(mockRedlock.acquire).toHaveBeenCalledTimes(1);
  });

  // ─── Idempotency / multiple calls ────────────────────────────────────────────

  test("two sequential ticks both emit server_tick when lock is always available", async () => {
    mockRedlock.acquire
      .mockResolvedValueOnce(mockLock)
      .mockResolvedValueOnce(mockLock);

    await tryTick();
    await tryTick();

    expect(emittedEvents).toHaveLength(2);
    expect(emittedEvents[0].event).toBe("server_tick");
    expect(emittedEvents[1].event).toBe("server_tick");
  });

  test("alternating lock available/unavailable: only emits on available ticks", async () => {
    mockRedlock.acquire
      .mockResolvedValueOnce(mockLock)                            // tick 1: lock available
      .mockRejectedValueOnce(new Error("held"))                   // tick 2: lock held
      .mockResolvedValueOnce(mockLock);                           // tick 3: lock available

    await tryTick();
    await tryTick();
    await tryTick();

    expect(emittedEvents).toHaveLength(2);
  });
});
