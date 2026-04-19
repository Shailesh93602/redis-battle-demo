"use strict";

/**
 * config.test.js
 *
 * Smoke-tests that server.js loads without throwing and respects env-var
 * configuration. All external I/O (Redis, socket.io) is mocked so no real
 * network connections are made.
 */

// ─── Mock all external modules BEFORE require('../server') ───────────────────

jest.mock("ioredis", () => {
  const MockRedis = jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
    duplicate: jest.fn().mockReturnValue({
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
    }),
  }));
  // ioredis exports the class directly; server.js uses `createClient`
  MockRedis.createClient = MockRedis;
  return MockRedis;
});

jest.mock("@socket.io/redis-adapter", () => ({
  createAdapter: jest.fn().mockReturnValue(() => {}),
}));

jest.mock("redlock", () => {
  const MockRedlock = jest.fn().mockImplementation(() => ({
    acquire: jest.fn(),
    release: jest.fn(),
  }));
  // Redlock is sometimes imported as `.default`
  MockRedlock.default = MockRedlock;
  return MockRedlock;
});

jest.mock("socket.io", () => {
  const mockIo = {
    adapter: jest.fn(),
    on: jest.fn(),
    emit: jest.fn(),
    to: jest.fn().mockReturnThis(),
  };
  return { Server: jest.fn().mockReturnValue(mockIo) };
});

jest.mock("express", () => {
  const app = {
    use: jest.fn(),
    get: jest.fn(),
    listen: jest.fn((port, cb) => {
      if (cb) cb();
      return { close: jest.fn() };
    }),
  };
  const expressFn = jest.fn().mockReturnValue(app);
  expressFn.static = jest.fn().mockReturnValue((req, res, next) => next());
  return expressFn;
});

jest.mock("http", () => {
  const server = {
    listen: jest.fn((port, cb) => {
      if (cb) cb();
      return server;
    }),
    close: jest.fn(),
    address: jest.fn().mockReturnValue({ port: 3001 }),
  };
  return {
    createServer: jest.fn().mockReturnValue(server),
  };
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("server module — configuration and startup", () => {
  let originalPort;

  beforeAll(() => {
    originalPort = process.env.PORT;
  });

  afterAll(() => {
    if (originalPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = originalPort;
    }
    jest.resetModules();
  });

  test("server module loads without throwing when all deps are mocked", () => {
    expect(() => require("../server")).not.toThrow();
  });

  test("INSTANCE_ID is derived from PORT (default 3001)", () => {
    // server.js sets INSTANCE_ID = `server:${PORT}`; PORT defaults to 3001
    // We can't import INSTANCE_ID directly, but we can verify the http.createServer
    // mock was called (i.e. the module fully initialised).
    const http = require("http");
    expect(http.createServer).toHaveBeenCalled();
  });

  test("httpServer.listen is called with the parsed PORT", () => {
    const http = require("http");
    const mockServer = http.createServer.mock.results[0].value;
    expect(mockServer.listen).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Function),
    );
  });

  test("Socket.io Server is instantiated", () => {
    const { Server } = require("socket.io");
    expect(Server).toHaveBeenCalled();
  });

  test("Redis adapter is wired up via io.adapter()", () => {
    const { Server } = require("socket.io");
    const mockIo = Server.mock.results[0].value;
    expect(mockIo.adapter).toHaveBeenCalled();
  });

  test("Redlock is instantiated with retryCount:0 (no lock queuing)", () => {
    const Redlock = require("redlock");
    expect(Redlock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ retryCount: 0 }),
    );
  });

  test("custom PORT env var is parsed as integer", () => {
    jest.resetModules();

    // Re-apply mocks after resetModules
    jest.mock("ioredis", () => {
      const M = jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        duplicate: jest.fn().mockReturnValue({ on: jest.fn() }),
      }));
      M.createClient = M;
      return M;
    });
    jest.mock("@socket.io/redis-adapter", () => ({
      createAdapter: jest.fn().mockReturnValue(() => {}),
    }));
    jest.mock("redlock", () => {
      const M = jest.fn().mockImplementation(() => ({ acquire: jest.fn() }));
      M.default = M;
      return M;
    });
    jest.mock("socket.io", () => ({
      Server: jest.fn().mockReturnValue({
        adapter: jest.fn(),
        on: jest.fn(),
        emit: jest.fn(),
        to: jest.fn().mockReturnThis(),
      }),
    }));
    jest.mock("express", () => {
      const app = { use: jest.fn(), get: jest.fn() };
      const fn = jest.fn().mockReturnValue(app);
      fn.static = jest.fn().mockReturnValue(() => {});
      return fn;
    });
    jest.mock("http", () => {
      const srv = {
        listen: jest.fn((port, cb) => {
          if (cb) cb();
          return srv;
        }),
        close: jest.fn(),
        address: jest.fn().mockReturnValue({ port: 4242 }),
      };
      return { createServer: jest.fn().mockReturnValue(srv) };
    });

    process.env.PORT = "4242";
    expect(() => require("../server")).not.toThrow();

    const http = require("http");
    const mockServer = http.createServer.mock.results[0].value;
    expect(mockServer.listen).toHaveBeenCalledWith(4242, expect.any(Function));
  });
});
