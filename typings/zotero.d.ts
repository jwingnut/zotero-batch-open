// Zotero 8–10 type definitions
// Minimal surface needed by Batch Open (modeled on zotero-zotadata's typings).

declare global {
  namespace Zotero {
    interface Item {
      id: number;
      libraryID: number;
      itemTypeID: number;
      getField(field: string): string;
      isRegularItem(): boolean;
      isTopLevelItem(): boolean;
      isAttachment(): boolean;
      isNote(): boolean;
      isAnnotation?(): boolean;
      getCreators(): Array<{
        firstName?: string;
        lastName: string;
        name?: string;
        creatorType?: string;
        creatorTypeID?: number;
        fieldMode?: number;
      }>;
      getAttachments(): number[];
    }

    namespace Items {
      function get(id: number): Item | null;
      function getAll(): Item[];
    }

    namespace ItemTypes {
      function getName(id: number): string;
      function getID(name: string): number;
    }

    namespace Utilities {
      function cleanDOI(doi: string): string;
    }

    /**
     * Zotero 8+ menu registration (single options object with menuID, target, menus).
     */
    namespace MenuManager {
      interface MenuData {
        menuType: "menuitem" | "separator" | "submenu";
        l10nID?: string;
        menus?: MenuData[];
        onCommand?: (event: Event, context: unknown) => void | void;
        onShowing?: (event: Event, context: unknown) => void | void;
      }

      interface MenuOptions {
        menuID: string;
        pluginID: string;
        /** e.g. main/library/item, main/library/collection, main/menubar/tools */
        target: string;
        menus: MenuData[];
      }

      function registerMenu(options: MenuOptions): string | false;

      function unregisterMenu(menuID: string): boolean;
    }

    // Prefs API
    namespace Prefs {
      function get<T = unknown>(key: string, defaultValue?: T): T;
      function set(key: string, value: unknown): void;
      function registerObserver(key: string, callback: () => void): void;
      function unregisterObserver(key: string, callback: () => void): void;
    }

    // ProgressWindow
    class ProgressWindow {
      constructor(options?: { closeOnClick?: boolean; window?: Window });
      changeHeadline(text: string): void;
      addDescription(text: string): void;
      addLines(label: string, icon?: string): void;
      show(): void;
      close(): void;
      startCloseTimer(delay?: number): void;
    }

    function log(message: string, level?: number): void;
    const initializationPromise: Promise<void>;
    const unlockPromise: Promise<void>;
    const uiReadyPromise: Promise<void>;
    function getMainWindows(): Window[];
    function getMainWindow(): Window;
    function getActiveZoteroPane(): {
      getSelectedItems(): Item[];
    } | null;
    /** Opens a URL in the system's default browser. */
    function launchURL(url: string): void;

    const platformMajorVersion: number;

    /** The directory holding the user's Zotero library (zotero.sqlite, storage/, etc). */
    namespace DataDirectory {
      let dir: string;
    }

    /** Fallback location when DataDirectory is unavailable (e.g. mid-startup). */
    function getProfileDirectory(): { path: string };
  }

  /** Firefox privileged-JS file I/O API (Firefox 115+ / Zotero 7+). */
  const IOUtils: {
    readUTF8(path: string): Promise<string>;
    writeUTF8(
      path: string,
      data: string,
      options?: Record<string, unknown>,
    ): Promise<number>;
  };

  /** Firefox privileged-JS path-joining helper (Firefox 115+ / Zotero 7+). */
  const PathUtils: {
    join(...parts: string[]): string;
  };

  // Firefox/XUL global interfaces
  const Cc: nsIXPCComponents_Classes;
  const Ci: nsIXPCComponents_Interfaces;
  const Cu: typeof Components.utils;

  // Services is auto-imported in Firefox 128+
  const Services: {
    wm: {
      addListener(listener: unknown): void;
      removeListener(listener: unknown): void;
      getEnumerator(windowType: string): unknown;
    };
    scriptloader: {
      loadSubScript(url: string, target?: unknown): void;
    };
    io: {
      newURI(uri: string): unknown;
    };
    prompt: {
      confirmEx(
        parent: Window | null,
        title: string,
        text: string,
        flags: number,
        btn0?: string | null,
        btn1?: string | null,
        btn2?: string | null,
        checkText?: string | null,
        checkState?: Record<string, unknown>,
      ): number;
    };
    [key: string]: unknown;
  };

  const ChromeUtils: {
    defineLazyGetter(obj: object, name: string, getter: () => unknown): void;
    defineESModuleGetters(obj: object, modules: Record<string, string>): void;
  };

  // Legacy globals (kept for compatibility during migration)
  const Components: { utils: unknown };
  const APP_SHUTDOWN: number;

  interface Window {
    ZoteroPane?: unknown;
    alert(message: string): void;
  }

  interface Document {
    createXULElement(name: string): Element;
    getElementById(id: string): HTMLElement | null;
    createElementNS(namespace: string, tagName: string): Element;
  }
}

interface nsIXPCComponents_Classes {
  [key: string]: unknown;
}

interface nsIXPCComponents_Interfaces {
  nsIWindowMediator: unknown;
  nsIDOMWindow: unknown;
  nsIInterfaceRequestor: unknown;
}

export {};
