import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  appendLogLine,
  capLogContent,
  flushFileLogForTests,
  formatUnhandledRejection,
  installUnhandledRejectionLogger,
  __resetFileLogForTests,
  __getResolvedLogPathForTests,
  MAX_LOG_CHARS,
  type FileIO,
} from "@/utils/fileLog";

type TestGlobal = {
  Zotero: typeof Zotero;
  PathUtils?: { join: (...parts: string[]) => string };
};

const testGlobal = globalThis as unknown as TestGlobal;

function fakeIO(initial = ""): FileIO & { written: string[] } {
  let content = initial;
  const written: string[] = [];
  return {
    written,
    readUTF8: vi.fn(async () => content),
    writeUTF8: vi.fn(async (_path: string, data: string) => {
      content = data;
      written.push(data);
      return data.length;
    }),
  };
}

describe("fileLog: log path resolution", () => {
  const originalDataDirectory = (
    testGlobal.Zotero as unknown as { DataDirectory?: unknown }
  ).DataDirectory;
  const originalGetProfileDirectory = (
    testGlobal.Zotero as unknown as { getProfileDirectory?: unknown }
  ).getProfileDirectory;

  beforeEach(() => {
    testGlobal.PathUtils = { join: (...parts) => parts.join("/") };
  });

  afterEach(() => {
    (
      testGlobal.Zotero as unknown as { DataDirectory?: unknown }
    ).DataDirectory = originalDataDirectory;
    (
      testGlobal.Zotero as unknown as { getProfileDirectory?: unknown }
    ).getProfileDirectory = originalGetProfileDirectory;
    delete testGlobal.PathUtils;
  });

  it("uses Zotero.DataDirectory.dir when available", async () => {
    (
      testGlobal.Zotero as unknown as { DataDirectory?: unknown }
    ).DataDirectory = { dir: "/data/dir" };
    const io = fakeIO();
    __resetFileLogForTests(io);

    appendLogLine("hello");
    await flushFileLogForTests();

    expect(__getResolvedLogPathForTests()).toBe("/data/dir/batch-open.log");
    expect(io.written).toHaveLength(1);
    expect(io.written[0]).toContain("hello");
  });

  it("falls back to the profile directory when DataDirectory is unavailable", async () => {
    (
      testGlobal.Zotero as unknown as { DataDirectory?: unknown }
    ).DataDirectory = undefined;
    (
      testGlobal.Zotero as unknown as { getProfileDirectory?: unknown }
    ).getProfileDirectory = () => ({ path: "/profile/dir" });
    const io = fakeIO();
    __resetFileLogForTests(io);

    appendLogLine("fallback");
    await flushFileLogForTests();

    expect(__getResolvedLogPathForTests()).toBe("/profile/dir/batch-open.log");
    expect(io.written).toHaveLength(1);
  });

  it("skips file logging silently when neither directory is available", async () => {
    (
      testGlobal.Zotero as unknown as { DataDirectory?: unknown }
    ).DataDirectory = undefined;
    (
      testGlobal.Zotero as unknown as { getProfileDirectory?: unknown }
    ).getProfileDirectory = undefined;
    const io = fakeIO();
    __resetFileLogForTests(io);

    expect(() => appendLogLine("no path")).not.toThrow();
    await flushFileLogForTests();

    expect(__getResolvedLogPathForTests()).toBeNull();
    expect(io.written).toHaveLength(0);
  });

  it("never throws even when the IO layer rejects", async () => {
    (
      testGlobal.Zotero as unknown as { DataDirectory?: unknown }
    ).DataDirectory = { dir: "/data/dir" };
    __resetFileLogForTests({
      readUTF8: vi.fn(async () => {
        throw new Error("read boom");
      }),
      writeUTF8: vi.fn(async () => {
        throw new Error("write boom");
      }),
    });

    expect(() => appendLogLine("still safe")).not.toThrow();
    await expect(flushFileLogForTests()).resolves.toBeUndefined();
  });
});

describe("fileLog: size cap", () => {
  it("returns content unchanged when under the cap", () => {
    const content = "a".repeat(100);
    expect(capLogContent(content, 1000)).toBe(content);
  });

  it("drops the oldest lines first when over the cap, realigning to a full line", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
    const content = lines.join("\n") + "\n";
    const cap = 200;

    const result = capLogContent(content, cap);

    expect(result.length).toBeLessThanOrEqual(cap);
    // The newest line must survive.
    expect(result).toContain("line-49");
    // The oldest line must be gone.
    expect(result).not.toContain("line-0\n");
    // Should not start mid-line (i.e. its first char begins a real line,
    // not a fragment of the line that was cut).
    expect(result.startsWith("line-")).toBe(true);
  });

  it("keeps appended content under MAX_LOG_CHARS by default", async () => {
    (
      globalThis as unknown as {
        Zotero: { DataDirectory?: { dir?: string } };
      }
    ).Zotero.DataDirectory = { dir: "/data/dir" };
    (globalThis as unknown as { PathUtils: unknown }).PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
    };

    const io = fakeIO("x".repeat(MAX_LOG_CHARS - 10));
    __resetFileLogForTests(io);

    appendLogLine("y".repeat(50));
    await flushFileLogForTests();

    expect(io.written[0].length).toBeLessThanOrEqual(MAX_LOG_CHARS);

    delete (globalThis as unknown as { PathUtils?: unknown }).PathUtils;
  });
});

describe("fileLog: unhandledrejection capture", () => {
  it("formats an Error reason with type, message, stack, and a promise identity", () => {
    const err = new Error("boom");
    const line = formatUnhandledRejection({
      reason: err,
      promise: {},
    });

    expect(line).toContain("UNHANDLED-REJECTION");
    expect(line).toContain("type=object");
    expect(line).toContain("message=boom");
    expect(line).toContain(err.stack ?? "");
    expect(line).toMatch(/promise=#\d+/);
  });

  it("formats a bare `undefined` rejection (the reported symptom) without throwing", () => {
    const line = formatUnhandledRejection({ reason: undefined, promise: {} });

    expect(line).toContain("type=undefined");
    expect(line).toContain("message=(none)");
  });

  it("assigns distinct ids to distinct promises and the same id to the same promise", () => {
    const p1 = {};
    const p2 = {};

    const a = formatUnhandledRejection({ reason: "x", promise: p1 });
    const b = formatUnhandledRejection({ reason: "y", promise: p1 });
    const c = formatUnhandledRejection({ reason: "z", promise: p2 });

    const idOf = (line: string) => line.match(/promise=(#\d+)/)?.[1];
    expect(idOf(a)).toBe(idOf(b));
    expect(idOf(a)).not.toBe(idOf(c));
  });

  it("installs and removes a window unhandledrejection listener", () => {
    const listeners: Array<(event: unknown) => void> = [];
    const win = {
      addEventListener: vi.fn((type: string, handler: (e: unknown) => void) => {
        if (type === "unhandledrejection") listeners.push(handler);
      }),
      removeEventListener: vi.fn(),
    } as unknown as Window;

    const cleanup = installUnhandledRejectionLogger(win);
    expect(win.addEventListener).toHaveBeenCalledWith(
      "unhandledrejection",
      expect.any(Function),
    );
    expect(listeners).toHaveLength(1);

    // Simulating a dispatched event must not throw, even for a bare
    // rejection with no reason at all.
    expect(() =>
      listeners[0]({ reason: undefined, promise: {} }),
    ).not.toThrow();

    cleanup();
    expect(win.removeEventListener).toHaveBeenCalledWith(
      "unhandledrejection",
      expect.any(Function),
    );
  });
});
