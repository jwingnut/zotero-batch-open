import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BatchOpenPlugin } from "@/plugin";

interface TestItem {
  id: number;
  isRegularItem(): boolean;
  getField(field: string): string;
  getCreators(): Array<{ lastName?: string }>;
  getAttachments(): number[];
}

function regularItem(
  fields: Record<string, string>,
  id = Math.random(),
): TestItem {
  return {
    id,
    isRegularItem: () => true,
    getField: (field: string) => fields[field] ?? "",
    getCreators: () => (fields.creator ? [{ lastName: fields.creator }] : []),
    getAttachments: () => [],
  };
}

function note(id = Math.random()): TestItem {
  return {
    id,
    isRegularItem: () => false,
    getField: () => "",
    getCreators: () => [],
    getAttachments: () => [],
  };
}

function setPane(items: TestItem[]): void {
  (
    Zotero as unknown as { getActiveZoteroPane: () => unknown }
  ).getActiveZoteroPane = () => ({ getSelectedItems: () => items });
}

function launchCalls(): string[] {
  return (globalThis as unknown as { __launchURLCalls: string[] })
    .__launchURLCalls;
}

// Keep the stagger delay out of test runtime.
beforeEach(() => {
  Zotero.Prefs.set("extensions.zotero.batchopen.delayMs", 0);
});

describe("BatchOpenPlugin — open all in browser", () => {
  it("opens a stored url directly", async () => {
    setPane([regularItem({ url: "https://example.com/a" })]);
    const plugin = new BatchOpenPlugin() as unknown as {
      runCommand(kind: "open" | "scholar" | "web"): Promise<void>;
    };
    await plugin.runCommand("open");
    expect(launchCalls()).toEqual(["https://example.com/a"]);
  });

  it("falls back to a DOI url when there is no stored url", async () => {
    setPane([regularItem({ DOI: "10.1000/xyz" })]);
    const plugin = new BatchOpenPlugin() as unknown as {
      runCommand(kind: "open" | "scholar" | "web"): Promise<void>;
    };
    await plugin.runCommand("open");
    expect(launchCalls()).toEqual(["https://doi.org/10.1000/xyz"]);
  });

  it("falls back to Google Scholar by default when nothing resolves", async () => {
    setPane([regularItem({ title: "Some Title", creator: "Author" })]);
    const plugin = new BatchOpenPlugin() as unknown as {
      runCommand(kind: "open" | "scholar" | "web"): Promise<void>;
    };
    await plugin.runCommand("open");
    expect(launchCalls()).toHaveLength(1);
    expect(launchCalls()[0]).toContain("scholar.google.com/scholar?q=");
  });

  it("skips items with no resolvable url when fallback is 'none'", async () => {
    Zotero.Prefs.set("extensions.zotero.batchopen.fallback", "none");
    setPane([regularItem({ title: "No URL Here" })]);
    const plugin = new BatchOpenPlugin() as unknown as {
      runCommand(kind: "open" | "scholar" | "web"): Promise<void>;
    };
    await plugin.runCommand("open");
    expect(launchCalls()).toEqual([]);
  });

  it("skips non-regular items (notes) and still opens the regular ones", async () => {
    setPane([note(), regularItem({ url: "https://example.com/b" })]);
    const plugin = new BatchOpenPlugin() as unknown as {
      runCommand(kind: "open" | "scholar" | "web"): Promise<void>;
    };
    await plugin.runCommand("open");
    expect(launchCalls()).toEqual(["https://example.com/b"]);
  });
});

describe("BatchOpenPlugin — search commands", () => {
  it("always searches Google Scholar, ignoring a stored url", async () => {
    setPane([regularItem({ url: "https://example.com/ignored", title: "T" })]);
    const plugin = new BatchOpenPlugin() as unknown as {
      runCommand(kind: "open" | "scholar" | "web"): Promise<void>;
    };
    await plugin.runCommand("scholar");
    expect(launchCalls()).toHaveLength(1);
    expect(launchCalls()[0]).toContain("scholar.google.com/scholar?q=");
  });

  it("uses the configured web search template", async () => {
    Zotero.Prefs.set(
      "extensions.zotero.batchopen.searchTemplate",
      "https://duckduckgo.com/?q={query}",
    );
    setPane([regularItem({ title: "Term" })]);
    const plugin = new BatchOpenPlugin() as unknown as {
      runCommand(kind: "open" | "scholar" | "web"): Promise<void>;
    };
    await plugin.runCommand("web");
    expect(launchCalls()).toEqual(["https://duckduckgo.com/?q=Term"]);
  });
});

describe("BatchOpenPlugin — dead progress window", () => {
  let originalProgressWindow: typeof Zotero.ProgressWindow;

  beforeEach(() => {
    originalProgressWindow = Zotero.ProgressWindow;
  });

  afterEach(() => {
    Zotero.ProgressWindow = originalProgressWindow;
  });

  it("falls back to a toast summary when the progress window is already closed", async () => {
    // Simulates closeOnClick / an already-fired close timer: any call after
    // construction throws, as it would against a dead window.
    class DeadProgressWindow {
      show() {}
      changeHeadline(): void {
        throw new Error("window is closed");
      }
      addDescription(): void {
        throw new Error("window is closed");
      }
      startCloseTimer(): void {
        throw new Error("window is closed");
      }
    }
    (Zotero as unknown as { ProgressWindow: unknown }).ProgressWindow =
      DeadProgressWindow;

    setPane([regularItem({ url: "https://example.com/a" })]);
    const plugin = new BatchOpenPlugin() as unknown as {
      runCommand(kind: "open" | "scholar" | "web"): Promise<void>;
    };

    await expect(plugin.runCommand("open")).resolves.toBeUndefined();
    // The item still opens even though every progress-window call failed.
    expect(launchCalls()).toEqual(["https://example.com/a"]);
  });

  it("does not throw when the progress window dies mid-run (closeOnClick)", async () => {
    class DiesAfterFirstCall {
      private calls = 0;
      show() {}
      changeHeadline(): void {
        this.calls += 1;
        if (this.calls > 1) {
          throw new Error("window is closed");
        }
      }
      addDescription(): void {
        throw new Error("window is closed");
      }
      startCloseTimer(): void {
        throw new Error("window is closed");
      }
    }
    (Zotero as unknown as { ProgressWindow: unknown }).ProgressWindow =
      DiesAfterFirstCall;

    setPane([
      regularItem({ url: "https://example.com/1" }),
      regularItem({ url: "https://example.com/2" }),
    ]);
    const plugin = new BatchOpenPlugin() as unknown as {
      runCommand(kind: "open" | "scholar" | "web"): Promise<void>;
    };

    await expect(plugin.runCommand("open")).resolves.toBeUndefined();
    expect(launchCalls()).toEqual([
      "https://example.com/1",
      "https://example.com/2",
    ]);
  });
});

describe("BatchOpenPlugin — repeated runs", () => {
  it("a second consecutive runCommand works after the first completed", async () => {
    setPane([regularItem({ url: "https://example.com/first" })]);
    const plugin = new BatchOpenPlugin() as unknown as {
      runCommand(kind: "open" | "scholar" | "web"): Promise<void>;
    };
    await plugin.runCommand("open");
    expect(launchCalls()).toEqual(["https://example.com/first"]);

    setPane([regularItem({ url: "https://example.com/second" })]);
    await plugin.runCommand("open");
    expect(launchCalls()).toEqual([
      "https://example.com/first",
      "https://example.com/second",
    ]);
  });

  it("a second consecutive runCommand works after the first failed", async () => {
    // First run: selection lookup itself throws (e.g. a stale pane).
    (
      Zotero as unknown as { getActiveZoteroPane: () => unknown }
    ).getActiveZoteroPane = () => {
      throw new Error("pane unavailable");
    };
    const plugin = new BatchOpenPlugin() as unknown as {
      runCommand(kind: "open" | "scholar" | "web"): Promise<void>;
    };
    await expect(plugin.runCommand("open")).resolves.toBeUndefined();
    expect(launchCalls()).toEqual([]);

    // Second run: pane is back, and the run succeeds normally.
    setPane([regularItem({ url: "https://example.com/after-failure" })]);
    await plugin.runCommand("open");
    expect(launchCalls()).toEqual(["https://example.com/after-failure"]);
  });
});

describe("BatchOpenPlugin — confirmation threshold", () => {
  it("does not open anything when the user cancels the confirmation", async () => {
    Zotero.Prefs.set("extensions.zotero.batchopen.confirmAbove", 1);
    (globalThis as unknown as { __confirmExResult: number }).__confirmExResult =
      1; // Cancel
    setPane([
      regularItem({ url: "https://example.com/1" }),
      regularItem({ url: "https://example.com/2" }),
    ]);
    const plugin = new BatchOpenPlugin() as unknown as {
      runCommand(kind: "open" | "scholar" | "web"): Promise<void>;
    };
    await plugin.runCommand("open");
    expect(launchCalls()).toEqual([]);
  });

  it("opens everything when the user confirms above the threshold", async () => {
    Zotero.Prefs.set("extensions.zotero.batchopen.confirmAbove", 1);
    (globalThis as unknown as { __confirmExResult: number }).__confirmExResult =
      0; // OK
    setPane([
      regularItem({ url: "https://example.com/1" }),
      regularItem({ url: "https://example.com/2" }),
    ]);
    const plugin = new BatchOpenPlugin() as unknown as {
      runCommand(kind: "open" | "scholar" | "web"): Promise<void>;
    };
    await plugin.runCommand("open");
    expect(launchCalls()).toHaveLength(2);
  });
});
