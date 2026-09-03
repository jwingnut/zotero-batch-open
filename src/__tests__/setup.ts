// src/__tests__/setup.ts
// Mock Zotero 8+ globals for testing (mirrors zotero-zotadata's setup.ts style).

import { beforeEach } from "vitest";

/** Recorded calls for Zotero 8+ MenuManager (Vitest assertions). */
const menuManagerRegisterCalls: Array<{
  menuID: string;
  pluginID: string;
  target: string;
  menus: Array<{ menuType: string; l10nID?: string }>;
}> = [];
const menuManagerUnregisterCalls: string[] = [];

function resetMenuManagerMocks(): void {
  menuManagerRegisterCalls.length = 0;
  menuManagerUnregisterCalls.length = 0;
}

/** Recorded calls to Zotero.launchURL (Vitest assertions). */
const launchURLCalls: string[] = [];

function resetLaunchURLMock(): void {
  launchURLCalls.length = 0;
}

type TestGlobal = {
  Zotero: typeof Zotero;
  Services: typeof Services;
  ChromeUtils: typeof ChromeUtils;
  __menuManagerRegisterCalls: typeof menuManagerRegisterCalls;
  __menuManagerUnregisterCalls: typeof menuManagerUnregisterCalls;
  __resetMenuManagerMocks: () => void;
  __launchURLCalls: typeof launchURLCalls;
  __resetLaunchURLMock: () => void;
  __confirmExResult: number;
};

const testGlobal = globalThis as unknown as TestGlobal;

testGlobal.__menuManagerRegisterCalls = menuManagerRegisterCalls;
testGlobal.__menuManagerUnregisterCalls = menuManagerUnregisterCalls;
testGlobal.__resetMenuManagerMocks = resetMenuManagerMocks;
testGlobal.__launchURLCalls = launchURLCalls;
testGlobal.__resetLaunchURLMock = resetLaunchURLMock;
testGlobal.__confirmExResult = 0; // 0 = OK/proceed by default

const prefsStore = new Map<string, unknown>();

// Mock Zotero object
testGlobal.Zotero = {
  log: console.log,
  initializationPromise: Promise.resolve(),
  unlockPromise: Promise.resolve(),
  uiReadyPromise: Promise.resolve(),
  getMainWindows: () => [],
  getMainWindow: () => undefined,
  getActiveZoteroPane: () => null,
  platformMajorVersion: 140,
  launchURL: (url: string) => {
    launchURLCalls.push(url);
  },
  Items: {
    get: () => null,
    getAll: () => [],
    trash: async () => {},
  },
  Attachments: {
    // Standard Zotero link-mode value for "linked URL" (not a stored file).
    LINK_MODE_LINKED_URL: 3,
  },
  ItemTypes: {
    getName: () => "journalArticle",
    getID: () => 1,
  },
  Utilities: {
    cleanDOI: (doi: string) =>
      doi
        .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
        .replace(/^doi:\s*/i, "")
        .trim(),
  },
  // Zotero 8+ Menu API mock (registerMenu returns string | false, like runtime)
  MenuManager: {
    registerMenu: (options: {
      menuID: string;
      pluginID: string;
      target: string;
      menus: Array<{ menuType: string; l10nID?: string }>;
    }) => {
      menuManagerRegisterCalls.push(options);
      return options.menuID;
    },
    unregisterMenu: (menuID: string) => {
      menuManagerUnregisterCalls.push(menuID);
      return true;
    },
  },
  Prefs: {
    get: (key: string, defaultValue?: unknown) =>
      prefsStore.has(key) ? prefsStore.get(key) : defaultValue,
    set: (key: string, value: unknown) => {
      prefsStore.set(key, value);
    },
    registerObserver: () => {},
    unregisterObserver: () => {},
  },
  ProgressWindow: class MockProgressWindow {
    changeHeadline(_text: string) {}
    addDescription(_text: string) {}
    addLines(_label: string) {}
    show() {}
    close() {}
    startCloseTimer(_delay?: number) {}
  },
} as unknown as typeof Zotero;

// Mock Services global (auto-imported in Firefox 128+)
testGlobal.Services = {
  wm: {
    addListener: () => {},
    removeListener: () => {},
    getEnumerator: () => ({
      hasMoreElements: () => false,
      getNext: () => null,
    }),
  },
  scriptloader: {
    loadSubScript: () => {},
  },
  io: {
    newURI: (uri: string) => ({ spec: uri }),
  },
  prompt: {
    confirmEx: () => testGlobal.__confirmExResult,
  },
} as unknown as typeof Services;

// Mock ChromeUtils
testGlobal.ChromeUtils = {
  defineLazyGetter: (obj: object, name: string, getter: () => unknown) => {
    Object.defineProperty(obj, name, { get: getter });
  },
  defineESModuleGetters: () => {},
} as unknown as typeof ChromeUtils;

// Mock document.createXULElement for DOM tests
if (typeof document !== "undefined") {
  document.createXULElement = document.createElement.bind(document);
}

// Reset mocks between tests
beforeEach(() => {
  resetMenuManagerMocks();
  resetLaunchURLMock();
  prefsStore.clear();
  testGlobal.__confirmExResult = 0;
});
