import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BatchOpenPlugin } from "@/plugin";
import { LIBRARY_ITEM_MENU_LABELS } from "@/constants/Menus";

type MenuHandler = (event: unknown, ctx: unknown) => void;

type MenuRegisterCall = {
  menuID: string;
  pluginID: string;
  target: string;
  menus: Array<{
    menuType: string;
    l10nID?: string;
    onShowing?: MenuHandler;
    onCommand?: MenuHandler;
    menus?: Array<{
      menuType: string;
      l10nID?: string;
      onShowing?: MenuHandler;
      onCommand?: MenuHandler;
    }>;
  }>;
};

function getMenuRegisterCalls(): MenuRegisterCall[] {
  return (
    (globalThis as { __menuManagerRegisterCalls?: MenuRegisterCall[] })
      .__menuManagerRegisterCalls ?? []
  );
}

function getMenuUnregisterCalls(): string[] {
  return (
    (globalThis as { __menuManagerUnregisterCalls?: string[] })
      .__menuManagerUnregisterCalls ?? []
  );
}

describe("MenuRegistration (Zotero 8+ MenuManager)", () => {
  it("calls registerMenu with menuID, pluginID, target, and menu items with onShowing labels, and no l10nID on the first (default) path", async () => {
    const plugin = new BatchOpenPlugin();
    await plugin.init({
      id: "batch-open@jwhitney",
      version: "0.1.0",
      rootURI: "",
    });

    const calls = getMenuRegisterCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].menuID).toBe("batch-open-main-library-item-actions");
    expect(calls[0].pluginID).toBe("batch-open@jwhitney");
    expect(calls[0].target).toBe("main/library/item");
    expect(calls[0].menus).toHaveLength(1);

    const root = calls[0].menus[0];
    expect(root.menuType).toBe("submenu");
    // Menu labels no longer depend on locale resolution: on the default
    // (label-only) path, l10nID is omitted entirely and onShowing sets the
    // label directly.
    expect(root.l10nID).toBeUndefined();
    expect(typeof root.onShowing).toBe("function");

    const actions = root.menus ?? [];
    expect(actions).toHaveLength(5);
    expect(actions.every((m) => m.menuType === "menuitem")).toBe(true);
    expect(actions.every((m) => typeof m.onShowing === "function")).toBe(true);
    expect(actions.map((m) => m.l10nID)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(LIBRARY_ITEM_MENU_LABELS).toEqual([
      "Open all in browser",
      "Search all in Google Scholar",
      "Search all in web search",
      "Open all in browser (only those missing a PDF)",
      "Attach newly saved files to the selected items",
    ]);
  });

  it("falls back to registering with l10nID when the label-only registration throws", async () => {
    const original = Zotero.MenuManager.registerMenu;
    const seenCalls: MenuRegisterCall[] = [];
    let callCount = 0;
    Zotero.MenuManager.registerMenu = ((options: MenuRegisterCall) => {
      seenCalls.push(options);
      callCount += 1;
      if (callCount === 1) {
        throw new Error("l10nID unresolvable in this locale chain");
      }
      return options.menuID;
    }) as typeof Zotero.MenuManager.registerMenu;

    const logSpy = vi.spyOn(Zotero, "log");

    const plugin = new BatchOpenPlugin();
    await plugin.init({
      id: "batch-open@jwhitney",
      version: "0.1.4",
      rootURI: "",
    });

    expect(callCount).toBe(2);
    expect(seenCalls[0].menus[0].l10nID).toBeUndefined();
    expect(seenCalls[1].menus[0].l10nID).toBe("batchopen-submenu");
    expect((seenCalls[1].menus[0].menus ?? [])[0].l10nID).toBe(
      "batchopen-menu-open-browser",
    );

    const logged = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(logged).toContain("falling back to l10nID path");
    expect(logged).toContain(
      "Registered menus using MenuManager API (path=l10nID-fallback, l10nID=true, entries=6)",
    );

    Zotero.MenuManager.registerMenu = original;
    logSpy.mockRestore();
  });

  it("reports the label-only path in the log when the default registration succeeds", async () => {
    const logSpy = vi.spyOn(Zotero, "log");

    const plugin = new BatchOpenPlugin();
    await plugin.init({
      id: "batch-open@jwhitney",
      version: "0.1.4",
      rootURI: "",
    });

    const logged = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(logged).toContain(
      "Registered menus using MenuManager API (path=label-only, l10nID=false, entries=6)",
    );

    logSpy.mockRestore();
  });

  it("shutdown does not call unregisterMenu (Zotero clears plugin menus on addon shutdown)", async () => {
    const plugin = new BatchOpenPlugin();
    await plugin.init({
      id: "batch-open@jwhitney",
      version: "0.1.0",
      rootURI: "",
    });
    await plugin.shutdown();

    expect(getMenuUnregisterCalls()).toEqual([]);
  });

  it("completes init when registerMenu returns false", async () => {
    const original = Zotero.MenuManager.registerMenu;
    Zotero.MenuManager.registerMenu = () => false;

    const plugin = new BatchOpenPlugin();
    await expect(
      plugin.init({ id: "batch-open@jwhitney", version: "0.1.0", rootURI: "" }),
    ).resolves.toBeUndefined();

    Zotero.MenuManager.registerMenu = original;
  });

  it("does not register the same MenuManager menu twice on main window ready", async () => {
    const plugin = new BatchOpenPlugin();
    await plugin.init({
      id: "batch-open@jwhitney",
      version: "0.1.0",
      rootURI: "",
    });

    const win = { ZoteroPane: {} } as unknown as Window;
    await plugin.onMainWindowReady(win);

    const calls = getMenuRegisterCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].menuID).toBe("batch-open-main-library-item-actions");
  });

  it("onShowing does not throw when called with an empty or partial context object", async () => {
    const plugin = new BatchOpenPlugin();
    await plugin.init({
      id: "batch-open@jwhitney",
      version: "0.1.0",
      rootURI: "",
    });

    const calls = getMenuRegisterCalls();
    const root = calls[0].menus[0];
    const action = (root.menus ?? [])[0];

    // Zotero 8-10 may omit menuElem, setEnabled, and items entirely.
    expect(() => root.onShowing?.({}, {})).not.toThrow();
    expect(() => root.onShowing?.({}, undefined)).not.toThrow();
    expect(() => action.onShowing?.({}, {})).not.toThrow();
    expect(() =>
      action.onShowing?.(
        {},
        { menuElem: undefined, setEnabled: undefined, items: undefined },
      ),
    ).not.toThrow();
    // A menuElem without setAttribute, or setEnabled that throws, must also
    // not propagate.
    expect(() =>
      action.onShowing?.(
        {},
        {
          menuElem: {},
          setEnabled: () => {
            throw new Error("boom");
          },
          items: [],
        },
      ),
    ).not.toThrow();
  });

  it("onCommand swallows and logs a synchronous throw from runCommand", async () => {
    const plugin = new BatchOpenPlugin() as unknown as {
      runCommand: (kind: string) => Promise<void>;
    };
    // Simulate a future regression where runCommand throws synchronously
    // instead of rejecting (e.g. a non-async refactor).
    plugin.runCommand = () => {
      throw new Error("synchronous boom");
    };

    await (plugin as unknown as BatchOpenPlugin).init({
      id: "batch-open@jwhitney",
      version: "0.1.0",
      rootURI: "",
    });

    const calls = getMenuRegisterCalls();
    const action = (calls[0].menus[0].menus ?? [])[0];

    expect(() => action.onCommand?.({}, {})).not.toThrow();
  });

  it("onCommand swallows and logs a callback that rejects with undefined", async () => {
    const plugin = new BatchOpenPlugin() as unknown as {
      runCommand: (kind: string) => Promise<void>;
    };
    // Simulate the reported crash: a callback whose promise rejects with no
    // value at all (e.g. a bare `Promise.reject()` or `throw undefined`).
    plugin.runCommand = () => Promise.reject();

    const logSpy = vi.spyOn(Zotero, "log");

    await (plugin as unknown as BatchOpenPlugin).init({
      id: "batch-open@jwhitney",
      version: "0.1.3",
      rootURI: "",
    });
    logSpy.mockClear();

    const calls = getMenuRegisterCalls();
    const action = (calls[0].menus[0].menus ?? [])[0];

    expect(() => action.onCommand?.({}, {})).not.toThrow();
    // Let the rejected promise's .catch handler run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const logged = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(logged).toContain("Batch Open");
    expect(logged).toContain("type=undefined");

    logSpy.mockRestore();
  });

  it("does not double-register when both the MenuManager and legacy paths are attempted", async () => {
    const plugin = new BatchOpenPlugin();
    await plugin.init({
      id: "batch-open@jwhitney",
      version: "0.1.0",
      rootURI: "",
    });

    // hasNewMenuAPI() is true in this environment (Zotero.MenuManager mock
    // is present), so onMainWindowReady must take the MenuManager branch
    // only, never falling through to the legacy XUL path as well.
    const win = { ZoteroPane: {} } as unknown as Window;
    await plugin.onMainWindowReady(win);
    await plugin.onMainWindowReady(win);

    expect(getMenuRegisterCalls()).toHaveLength(1);
  });
});

// --- Minimal fake DOM, just enough to exercise the legacy XUL menu path
// without a jsdom dependency (vitest's environment here is "node"). ---

class FakeElement {
  tagName: string;
  attrs = new Map<string, string>();
  children: FakeElement[] = [];
  listeners = new Map<string, Array<() => void>>();
  parent: FakeElement | null = null;
  ownerDoc: FakeDocument | null = null;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get id(): string {
    return this.attrs.get("id") ?? "";
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  addEventListener(type: string, handler: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatch(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler();
    }
  }

  appendChild(child: FakeElement): void {
    child.parent = this;
    this.children.push(child);
  }

  remove(): void {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    }
    this.ownerDoc?.unindexTree(this);
  }
}

class FakeDocument {
  private byId = new Map<string, FakeElement>();

  createXULElement(tagName: string): FakeElement {
    const el = new FakeElement(tagName);
    el.ownerDoc = this;
    return el;
  }

  createElementNS(_ns: string, tagName: string): FakeElement {
    const el = new FakeElement(tagName);
    el.ownerDoc = this;
    return el;
  }

  getElementById(id: string): FakeElement | null {
    return this.byId.get(id) ?? null;
  }

  /** Test helper: index an element (and its descendants) by id after building the tree. */
  index(el: FakeElement): void {
    if (el.id) {
      this.byId.set(el.id, el);
    }
    for (const child of el.children) {
      this.index(child);
    }
  }

  unindexTree(el: FakeElement): void {
    if (el.id) {
      this.byId.delete(el.id);
    }
    for (const child of el.children) {
      this.unindexTree(child);
    }
  }
}

describe("MenuRegistration (legacy XUL fallback)", () => {
  let originalMenuManager: typeof Zotero.MenuManager;

  beforeEach(() => {
    originalMenuManager = Zotero.MenuManager;
    // Simulate a Zotero build without the MenuManager API.
    (Zotero as unknown as { MenuManager?: unknown }).MenuManager = undefined;
  });

  afterEach(() => {
    Zotero.MenuManager = originalMenuManager;
  });

  it("injects a XUL submenu with three menu items into zotero-itemmenu", async () => {
    const fakeDoc = new FakeDocument();
    const parent = new FakeElement("menupopup");
    parent.setAttribute("id", "zotero-itemmenu");
    fakeDoc.index(parent);

    // The plugin looks up the parent via doc.getElementById and appends to
    // it directly; index each newly created child as it's appended so
    // getElementById can find it (mimicking a live DOM).
    const originalAppendChild = parent.appendChild.bind(parent);
    parent.appendChild = (child: FakeElement) => {
      originalAppendChild(child);
      fakeDoc.index(child);
    };

    const win = {
      ZoteroPane: {},
      document: fakeDoc as unknown as Document,
    } as unknown as Window;

    // shutdown() removes menus via Zotero.getMainWindows(), so the fake
    // window needs to be discoverable there too (mirrors the real bootstrap
    // flow, where Zotero tracks open main windows itself).
    const originalGetMainWindows = Zotero.getMainWindows;
    Zotero.getMainWindows = () => [win];

    const plugin = new BatchOpenPlugin();
    await plugin.init({
      id: "batch-open@jwhitney",
      version: "0.1.0",
      rootURI: "",
    });
    await plugin.onMainWindowReady(win);

    const menu = fakeDoc.getElementById("zotero-itemmenu-batch-open-menu");
    expect(menu).not.toBeNull();
    expect(menu?.getAttribute("label")).toBe("Batch Open");

    const items = [
      "zotero-itemmenu-batch-open-open-browser",
      "zotero-itemmenu-batch-open-search-scholar",
      "zotero-itemmenu-batch-open-search-web",
    ].map((id) => fakeDoc.getElementById(id));
    expect(items.every((el) => el !== null)).toBe(true);
    expect(items.map((el) => el?.getAttribute("label"))).toEqual([
      "Open all in browser",
      "Search all in Google Scholar",
      "Search all in web search",
    ]);

    // No MenuManager registration should have happened on this path.
    expect(getMenuRegisterCalls()).toEqual([]);

    await plugin.shutdown();
    expect(
      fakeDoc.getElementById("zotero-itemmenu-batch-open-menu"),
    ).toBeNull();

    Zotero.getMainWindows = originalGetMainWindows;
  });
});
