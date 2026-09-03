/**
 * A tiny on-disk log for Batch Open, so a failure can be diagnosed without
 * the user opening Zotero's Debug Output Logging console.
 *
 * Writes to `<Zotero data directory>/batch-open.log`, falling back to the
 * profile directory when the data directory isn't available yet, and
 * disabling itself (silently — logging must never break the plugin) when
 * neither is available.
 */

export const LOG_FILE_NAME = "batch-open.log";

/** Soft cap on the log file's size; oldest lines are dropped first. */
export const MAX_LOG_CHARS = 256 * 1024;

export interface FileIO {
  readUTF8(path: string): Promise<string>;
  writeUTF8(path: string, data: string): Promise<number>;
}

function defaultIO(): FileIO {
  return {
    readUTF8: (path: string) => IOUtils.readUTF8(path),
    writeUTF8: (path: string, data: string) => IOUtils.writeUTF8(path, data),
  };
}

let io: FileIO = defaultIO();

/** undefined = not yet resolved; null = resolved to "logging disabled". */
let logPath: string | null | undefined;

/** Serializes writes so concurrent appendLogLine calls don't clobber each other. */
let writeChain: Promise<void> = Promise.resolve();

function joinPath(dir: string, name: string): string {
  try {
    if (typeof PathUtils !== "undefined" && PathUtils?.join) {
      return PathUtils.join(dir, name);
    }
  } catch {
    // Fall through to a manual join.
  }
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

function resolveLogPath(): string | null {
  if (logPath !== undefined) {
    return logPath;
  }

  try {
    const dataDir = (Zotero as unknown as { DataDirectory?: { dir?: string } })
      .DataDirectory?.dir;
    if (typeof dataDir === "string" && dataDir) {
      logPath = joinPath(dataDir, LOG_FILE_NAME);
      return logPath;
    }
  } catch {
    // Fall through to the profile directory.
  }

  try {
    const profileDir = (
      Zotero as unknown as {
        getProfileDirectory?: () => { path?: string } | undefined;
      }
    ).getProfileDirectory?.()?.path;
    if (typeof profileDir === "string" && profileDir) {
      logPath = joinPath(profileDir, LOG_FILE_NAME);
      return logPath;
    }
  } catch {
    // Fall through to disabled.
  }

  logPath = null;
  return null;
}

/**
 * Cap `content` to ~MAX_LOG_CHARS by dropping the oldest lines first,
 * realigning to the next full line so the file never starts mid-line.
 */
export function capLogContent(
  content: string,
  maxChars: number = MAX_LOG_CHARS,
): string {
  if (content.length <= maxChars) {
    return content;
  }
  const excess = content.length - maxChars;
  let trimmed = content.slice(excess);
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline >= 0 && firstNewline < trimmed.length - 1) {
    trimmed = trimmed.slice(firstNewline + 1);
  }
  return trimmed;
}

/**
 * Append one line to the log file, with an ISO timestamp prefix. Fire and
 * forget: never throws, and does nothing when no writable path is available.
 */
export function appendLogLine(message: string): void {
  const path = resolveLogPath();
  if (!path) {
    return;
  }

  const line = `${new Date().toISOString()} ${message}\n`;

  writeChain = writeChain
    .then(async () => {
      let existing = "";
      try {
        existing = await io.readUTF8(path);
      } catch {
        existing = "";
      }
      const combined = capLogContent(existing + line);
      await io.writeUTF8(path, combined);
    })
    .catch(() => {
      // A logging failure must never surface or break the write chain.
    });
}

/** Waits for all writes queued so far (test helper). */
export function flushFileLogForTests(): Promise<void> {
  return writeChain;
}

/** Resets cached path/IO state between tests; optionally injects a fake IO. */
export function __resetFileLogForTests(customIO?: FileIO): void {
  logPath = undefined;
  writeChain = Promise.resolve();
  io = customIO ?? defaultIO();
}

export function __getResolvedLogPathForTests(): string | null | undefined {
  return logPath;
}

// ---------------------------------------------------------------------
// unhandledrejection capture
// ---------------------------------------------------------------------

const promiseIds = new WeakMap<object, number>();
let nextPromiseId = 1;

function describePromiseIdentity(promise: unknown): string {
  if (!promise || typeof promise !== "object") {
    return "unknown";
  }
  let id = promiseIds.get(promise as object);
  if (id === undefined) {
    id = nextPromiseId++;
    promiseIds.set(promise as object, id);
  }
  return `#${id}`;
}

/** Formats a PromiseRejectionEvent into the single line logged for it. */
export function formatUnhandledRejection(event: {
  reason?: unknown;
  promise?: unknown;
}): string {
  const reason = event?.reason;
  const reasonType = typeof reason;

  let message: string | undefined;
  let stack: string | undefined;
  try {
    if (reason instanceof Error) {
      message = reason.message;
      stack = reason.stack;
    } else if (reason !== undefined && reason !== null) {
      message = String(reason);
    }
  } catch {
    // Leave message/stack undefined if inspecting reason itself throws.
  }

  const promiseId = describePromiseIdentity(event?.promise);

  let line = `UNHANDLED-REJECTION type=${reasonType} message=${
    message ?? "(none)"
  } promise=${promiseId}`;
  if (stack) {
    line += `\n${stack}`;
  }
  return line;
}

/**
 * Installs a window-level `unhandledrejection` listener that logs to the
 * file log, so a bare `Uncaught (in promise) undefined` can be diagnosed
 * even when it doesn't originate in Batch Open's own code. Returns a
 * cleanup function that removes the listener (call on window unload).
 */
export function installUnhandledRejectionLogger(win: Window): () => void {
  const handler = (event: Event): void => {
    try {
      appendLogLine(
        formatUnhandledRejection(
          event as unknown as { reason?: unknown; promise?: unknown },
        ),
      );
    } catch {
      // A logging failure must never surface as another rejection.
    }
  };

  win.addEventListener("unhandledrejection", handler);
  return () => {
    win.removeEventListener("unhandledrejection", handler);
  };
}
