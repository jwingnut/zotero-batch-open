import { ZoteroUtils } from "@/utils/ZoteroUtils";
import {
  LIBRARY_ITEM_MENU_LABELS,
  LIBRARY_ITEM_MENU_L10N_IDS,
  LIBRARY_ITEM_SUBMENU_L10N_ID,
  MenuParentID,
  SUBMENU_LABEL,
} from "@/constants/Menus";
import { splitSelection } from "@/core/selection";
import { buildSearchQuery } from "@/core/query";
import {
  resolveOpenUrl,
  scholarSearchUrl,
  webSearchUrl,
  validateSearchTemplate,
  DEFAULT_SEARCH_TEMPLATE,
  type FallbackSetting,
  type ResolvedUrl,
} from "@/core/urlResolution";
import { shouldConfirm, confirmPromptMessage } from "@/core/confirm";
import type { AddonData } from "@/shared/types";

type CommandKind = "open" | "scholar" | "web";

const COMMAND_LABELS: Record<CommandKind, string> = {
  open: LIBRARY_ITEM_MENU_LABELS[0],
  scholar: LIBRARY_ITEM_MENU_LABELS[1],
  web: LIBRARY_ITEM_MENU_LABELS[2],
};

const PREF = {
  fallback: "extensions.zotero.batchopen.fallback",
  searchTemplate: "extensions.zotero.batchopen.searchTemplate",
  confirmAbove: "extensions.zotero.batchopen.confirmAbove",
  delayMs: "extensions.zotero.batchopen.delayMs",
} as const;

interface SourceCounts {
  stored: number;
  doi: number;
  attachment: number;
  "fallback-scholar": number;
  "fallback-web": number;
  skipped: number;
}

function emptyCounts(): SourceCounts {
  return {
    stored: 0,
    doi: 0,
    attachment: 0,
    "fallback-scholar": 0,
    "fallback-web": 0,
    skipped: 0,
  };
}

/**
 * Main "Batch Open" plugin class: menu registration and the batch-opening
 * commands themselves.
 */
export class BatchOpenPlugin {
  private addonData: AddonData | null = null;
  private addedElementIDs: string[] = [];
  private menuManagerRegistered = false;

  async init(data: AddonData): Promise<void> {
    this.addonData = data;
    this.log(`${this.version()} starting`);
    await this.registerMenus();
  }

  /** The running plugin version, for logging and on-screen display. */
  private version(): string {
    return this.addonData?.version || "?";
  }

  /**
   * Last-resort guard for a menu callback / command entry point.
   *
   * `fn` may throw synchronously or return a rejecting promise (including
   * one that rejects with `undefined`, e.g. `Promise.reject()`). Either way
   * this method guarantees the failure is logged with its type and stack
   * (when available) and surfaced to the user — it never lets a bare
   * rejection escape, and the reporting itself cannot throw.
   */
  private guard(context: string, fn: () => void | Promise<void>): void {
    try {
      const result = fn();
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch((error: unknown) => {
          this.reportError(context, error);
        });
      }
    } catch (error) {
      this.reportError(context, error);
    }
  }

  /**
   * Log and surface an error from a guarded entry point. Defensive by
   * design: every step is wrapped so this method itself cannot throw or
   * produce a new unhandled rejection, even if `error` is `undefined` or
   * something unusual.
   */
  private reportError(context: string, error: unknown): void {
    let type = "unknown";
    let detail = "(no message)";
    let stack: string | undefined;

    try {
      type =
        error === undefined
          ? "undefined"
          : error === null
            ? "null"
            : (error as { constructor?: { name?: string } })?.constructor
                ?.name || typeof error;
      detail = error instanceof Error ? error.message : String(error);
      stack = error instanceof Error ? error.stack : undefined;
    } catch {
      // Even inspecting the error threw; fall back to the defaults above.
    }

    try {
      this.log(
        `${context} failed: type=${type} message=${detail}${
          stack ? `\n${stack}` : ""
        }`,
      );
    } catch {
      // Nothing more we can do about logging failing.
    }

    try {
      this.toast(
        SUBMENU_LABEL,
        `Something went wrong (${context}). See Help → Debug Output ` +
          `Logging → View Output and search "Batch Open" for details.`,
        { short: true },
      );
    } catch {
      // toast() already has its own internal fallback and catch; this is
      // only a final backstop in case something unexpected still throws.
    }
  }

  async shutdown(): Promise<void> {
    this.menuManagerRegistered = false;

    // Do not call MenuManager.unregisterMenu: Zotero removes plugin menu
    // registrations during addon shutdown; a second unregister logs
    // "Can't remove unknown option" and can run after cleanup.

    await this.removeFromAllWindows();
  }

  /**
   * Called when a main Zotero window loads.
   * Used for legacy XUL menus and as a fallback when MenuManager API is used.
   */
  async onMainWindowReady(win: Window): Promise<void> {
    if (!ZoteroUtils.hasNewMenuAPI() && win.ZoteroPane) {
      await this.addToWindow(win);
    } else if (ZoteroUtils.hasNewMenuAPI() && !this.menuManagerRegistered) {
      try {
        await this.registerMenusWithMenuAPI();
      } catch (error) {
        this.log(`Failed to register menus on window ready: ${error}`);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Menu registration (Zotero 8+ MenuManager, with legacy XUL fallback)
  // ---------------------------------------------------------------------

  private async registerMenus(): Promise<void> {
    try {
      if (ZoteroUtils.hasNewMenuAPI()) {
        await this.registerMenusWithMenuAPI();
      } else {
        await this.registerMenusLegacy();
      }
    } catch (error) {
      this.log(`Failed to register menus: ${error}`);
    }
  }

  private async registerMenusWithMenuAPI(): Promise<void> {
    if (this.menuManagerRegistered) {
      return;
    }

    const pluginID = this.addonData?.id || "batch-open@jwhitney";
    const menuID = "batch-open-main-library-item-actions";
    const commands: CommandKind[] = ["open", "scholar", "web"];

    const contextShowing = (
      ctx: {
        menuElem?: Element;
        setEnabled?: (enabled: boolean) => void;
        items?: Zotero.Item[];
      },
      label: string,
    ): void => {
      // ctx is supplied by Zotero and its shape varies across Zotero 8-10;
      // every member is treated as possibly absent and this must never throw
      // or return a rejected promise, or the item context menu breaks.
      try {
        ctx?.menuElem?.setAttribute?.("label", label);
      } catch (error) {
        this.log(`contextShowing: failed to set label: ${error}`);
      }

      try {
        const items = ctx?.items;
        let enabled = true;
        if (Array.isArray(items)) {
          enabled =
            items.length > 0 && items.some((item) => item?.isRegularItem?.());
        }
        ctx?.setEnabled?.(enabled);
      } catch (error) {
        this.log(`contextShowing: failed to set enabled state: ${error}`);
      }
    };

    const safeOnShowing = (
      label: string,
    ): Zotero.MenuManager.MenuData["onShowing"] => {
      return (_event, ctx) => {
        try {
          contextShowing(
            ctx as {
              menuElem?: Element;
              setEnabled?: (enabled: boolean) => void;
              items?: Zotero.Item[];
            },
            label,
          );
        } catch (error) {
          this.log(`onShowing handler failed: ${error}`);
        }
      };
    };

    const actionMenus: Zotero.MenuManager.MenuData[] =
      LIBRARY_ITEM_MENU_L10N_IDS.map((l10nID, i) => ({
        menuType: "menuitem" as const,
        l10nID,
        onShowing: safeOnShowing(LIBRARY_ITEM_MENU_LABELS[i]),
        onCommand: () => {
          this.guard(`onCommand(${commands[i]})`, () =>
            this.runCommand(commands[i]),
          );
        },
      }));

    const menus: Zotero.MenuManager.MenuData[] = [
      {
        menuType: "submenu",
        l10nID: LIBRARY_ITEM_SUBMENU_L10N_ID,
        onShowing: safeOnShowing(SUBMENU_LABEL),
        menus: actionMenus,
      },
    ];

    const registered = Zotero.MenuManager.registerMenu({
      menuID,
      pluginID,
      target: "main/library/item",
      menus,
    });

    if (registered !== false) {
      this.menuManagerRegistered = true;
      this.log("Registered menus using MenuManager API");
    } else {
      this.log("MenuManager.registerMenu returned false; menus unavailable");
    }
  }

  private async registerMenusLegacy(): Promise<void> {
    const windows = Zotero.getMainWindows();
    for (const window of windows) {
      if (window.ZoteroPane) {
        await this.addToWindow(window);
      }
    }
    this.log("Registered menus using legacy XUL approach");
  }

  private async addToWindow(window: Window): Promise<void> {
    try {
      const doc = window.document;

      if (doc.getElementById("zotero-itemmenu-batch-open-menu")) {
        // Already added to this window (e.g. onMainWindowReady fired more
        // than once for it); avoid appending a second, duplicate-ID menu.
        this.log("Menu already present in window; skipping duplicate add");
        return;
      }

      const menu = ZoteroUtils.createXULElement(doc, "menu", {
        id: "zotero-itemmenu-batch-open-menu",
        class: "menu-iconic",
        label: SUBMENU_LABEL,
      });

      const menuPopup = ZoteroUtils.createXULElement(doc, "menupopup", {
        id: "zotero-itemmenu-batch-open-menupopup",
      });

      const commandForIndex: CommandKind[] = ["open", "scholar", "web"];
      const menuItemDefs = [
        {
          id: "zotero-itemmenu-batch-open-open-browser",
          label: LIBRARY_ITEM_MENU_LABELS[0],
        },
        {
          id: "zotero-itemmenu-batch-open-search-scholar",
          label: LIBRARY_ITEM_MENU_LABELS[1],
        },
        {
          id: "zotero-itemmenu-batch-open-search-web",
          label: LIBRARY_ITEM_MENU_LABELS[2],
        },
      ];

      menuItemDefs.forEach((def, i) => {
        const menuItem = ZoteroUtils.createXULElement(doc, "menuitem", {
          id: def.id,
          label: def.label,
        });
        menuItem.addEventListener("command", () => {
          this.guard(`legacyCommand(${commandForIndex[i]})`, () =>
            this.runCommand(commandForIndex[i]),
          );
        });
        menuPopup.appendChild(menuItem);
        this.addedElementIDs.push(def.id);
      });

      menu.appendChild(menuPopup);
      this.addedElementIDs.push(menu.id);

      const parentMenu = doc.getElementById(MenuParentID.ITEM_CONTEXT);
      if (parentMenu) {
        parentMenu.appendChild(menu);
        this.log("Successfully added menu to window");
      } else {
        throw new Error("Could not find zotero-itemmenu parent element");
      }
    } catch (error) {
      this.log(`Failed to add menu to window: ${error}`);
    }
  }

  private async removeFromAllWindows(): Promise<void> {
    const windows = Zotero.getMainWindows();
    for (const window of windows) {
      if (window.ZoteroPane) {
        this.removeFromWindow(window);
      }
    }
  }

  private removeFromWindow(window: Window): void {
    const doc = window.document;
    for (const id of this.addedElementIDs) {
      const element = doc.getElementById(id);
      if (element) {
        element.remove();
      }
    }
  }

  // ---------------------------------------------------------------------
  // Batch commands
  // ---------------------------------------------------------------------

  private async runCommand(kind: CommandKind): Promise<void> {
    let selectedCount = 0;
    try {
      const pane = Zotero.getActiveZoteroPane();
      const selected = pane ? pane.getSelectedItems() : [];
      selectedCount = selected.length;
      this.log(`command=${kind} selected=${selectedCount}`);

      await this.runCommandBody(kind, selected);

      this.log(`command=${kind} completed`);
    } catch (error) {
      // runCommandBody should not throw (its own steps are guarded below),
      // but this is the final backstop for this entry point: nothing from
      // here escapes as a bare rejection.
      this.reportError(`runCommand(${kind})`, error);
    }
  }

  private async runCommandBody(
    kind: CommandKind,
    selected: Zotero.Item[],
  ): Promise<void> {
    if (selected.length === 0) {
      this.toast(COMMAND_LABELS[kind], "No items selected.", { short: true });
      return;
    }

    const { regularItems, skippedCount } = splitSelection(selected);

    if (regularItems.length === 0) {
      this.toast(
        COMMAND_LABELS[kind],
        "No regular items in the selection (notes, attachments, and annotations are skipped).",
        { short: true },
      );
      return;
    }

    const confirmAbove = this.getPref(PREF.confirmAbove, 25);
    if (shouldConfirm(regularItems.length, confirmAbove)) {
      const proceed = this.confirm(confirmPromptMessage(regularItems.length));
      if (!proceed) {
        this.toast(COMMAND_LABELS[kind], "Cancelled. 0 items opened.", {
          short: true,
        });
        return;
      }
    }

    const delayMs = this.getPref(PREF.delayMs, 300);
    const fallback = this.getPref(PREF.fallback, "scholar") as FallbackSetting;
    const rawTemplate = this.getPref(
      PREF.searchTemplate,
      DEFAULT_SEARCH_TEMPLATE,
    );
    const { template, warning } = validateSearchTemplate(rawTemplate);
    if (warning) {
      this.log(warning);
    }

    const counts = emptyCounts();
    const errorLabels: string[] = [];
    let opened = 0;

    const progress = this.createProgressWindow();
    this.safeProgress(progress, (w) =>
      w.changeHeadline(`Batch Open · ${COMMAND_LABELS[kind]}`),
    );

    for (let i = 0; i < regularItems.length; i++) {
      const item = regularItems[i];
      this.safeProgress(progress, (w) =>
        w.changeHeadline(`Opening ${i + 1} of ${regularItems.length}…`),
      );

      try {
        const resolved = this.resolveForCommand(kind, item, fallback, template);
        if (resolved.url) {
          Zotero.launchURL(resolved.url);
          opened += 1;
          counts[resolved.source as keyof SourceCounts] += 1;
        } else {
          counts.skipped += 1;
        }
      } catch (error) {
        errorLabels.push(this.itemLabel(item));
        this.log(`Failed to open item: ${error}`);
      }

      if (delayMs > 0 && i < regularItems.length - 1) {
        await this.sleep(delayMs);
      }
    }

    const summary = this.formatSummary(
      kind,
      regularItems.length,
      opened,
      counts,
      skippedCount,
      errorLabels,
    );

    const headline = `Batch Open ${this.version()} · opened ${opened} of ${regularItems.length}`;
    const shownDescriptionLines = summary.slice(1); // "Opened N of M" is now in the headline.

    const progressUsable = this.safeProgress(
      progress,
      (w) => {
        w.changeHeadline(headline);
        for (const line of shownDescriptionLines) {
          w.addDescription(line);
        }
        w.startCloseTimer(Math.min(14500, 4300 + summary.length * 520));
        return true;
      },
      false,
    );

    if (!progressUsable) {
      this.toast(COMMAND_LABELS[kind], summary.join("\n"));
    }
  }

  /** Resolve the URL to open for a single item, per the active command. */
  private resolveForCommand(
    kind: CommandKind,
    item: Zotero.Item,
    fallback: FallbackSetting,
    webTemplate: string,
  ): ResolvedUrl {
    const query = buildSearchQuery(item);

    if (kind === "scholar") {
      return { url: scholarSearchUrl(query), source: "fallback-scholar" };
    }
    if (kind === "web") {
      return { url: webSearchUrl(webTemplate, query), source: "fallback-web" };
    }

    return resolveOpenUrl(item, Zotero.Items, {
      fallback,
      searchQuery: query,
      webTemplate,
    });
  }

  private formatSummary(
    kind: CommandKind,
    totalRegular: number,
    opened: number,
    counts: SourceCounts,
    skippedCount: number,
    errorLabels: string[],
  ): string[] {
    const lines: string[] = [`Opened ${opened} of ${totalRegular} item(s).`];

    if (kind === "open") {
      lines.push(`• From a stored URL: ${counts.stored}`);
      lines.push(`• From a DOI: ${counts.doi}`);
      lines.push(`• From an attachment URL: ${counts.attachment}`);
      const fellBack = counts["fallback-scholar"] + counts["fallback-web"];
      lines.push(`• Fell back to a search: ${fellBack}`);
      if (counts.skipped > 0) {
        lines.push(
          `• Skipped (no URL, DOI, or attachment; fallback set to skip): ${counts.skipped}`,
        );
      }
    }

    if (skippedCount > 0) {
      lines.push(
        `• Skipped from selection (notes, attachments, or annotations): ${skippedCount}`,
      );
    }

    if (errorLabels.length > 0) {
      lines.push(`• Errors: ${errorLabels.length}`);
      const detail = errorLabels.slice(0, 5).map((label) => `  – ${label}`);
      lines.push(...detail);
      if (errorLabels.length > 5) {
        lines.push(`  … and ${errorLabels.length - 5} more not listed`);
      }
    }

    return lines;
  }

  private itemLabel(item: Zotero.Item): string {
    try {
      return item.getField("title") || `Item ${item.id}`;
    } catch {
      return `Item ${item.id}`;
    }
  }

  // ---------------------------------------------------------------------
  // Small platform helpers (thin enough to not need dedicated unit tests)
  // ---------------------------------------------------------------------

  private getPref<T>(key: string, defaultValue: T): T {
    try {
      const value = Zotero.Prefs.get(key, defaultValue);
      return (value ?? defaultValue) as T;
    } catch {
      return defaultValue;
    }
  }

  private confirm(message: string): boolean {
    try {
      const window = Zotero.getMainWindow();
      // BUTTON_POS_0 * BUTTON_TITLE_OK + BUTTON_POS_1 * BUTTON_TITLE_CANCEL
      // (nsIPromptService flag encoding: POS_0=0, POS_1=256, TITLE_OK=1, TITLE_CANCEL=2)
      const flags = 0 * 1 + 256 * 2;
      const button = Services.prompt.confirmEx(
        window ?? null,
        "Batch Open",
        message,
        flags,
        "Open",
        "Cancel",
        null,
        null,
        {},
      );
      return button === 0;
    } catch (error) {
      this.log(`Confirm dialog failed, proceeding: ${error}`);
      return true;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private createProgressWindow(): Zotero.ProgressWindow | null {
    try {
      const win = new Zotero.ProgressWindow({ closeOnClick: true });
      win.show();
      return win;
    } catch (error) {
      this.log(`ProgressWindow unavailable: ${error}`);
      return null;
    }
  }

  /**
   * Call into a possibly-dead `ProgressWindow` (it may have been closed by
   * `closeOnClick`, a prior close timer, or a race with the user) without
   * letting that throw escape. On failure this degrades to a log line and
   * returns `fallback` instead of raising.
   */
  private safeProgress<T>(
    win: Zotero.ProgressWindow | null,
    fn: (w: Zotero.ProgressWindow) => T,
    fallback?: T,
  ): T | undefined {
    if (!win) {
      return fallback;
    }
    try {
      return fn(win);
    } catch (error) {
      this.log(
        `ProgressWindow interaction failed (window likely closed): ${error}`,
      );
      return fallback;
    }
  }

  private toast(
    operationName: string,
    detailText: string,
    options?: { short?: boolean },
  ): void {
    try {
      const win = new Zotero.ProgressWindow({ closeOnClick: true });
      win.changeHeadline(`Batch Open · ${operationName}`);
      for (const line of detailText.split("\n")) {
        win.addDescription(line);
      }
      win.show();
      win.startCloseTimer(options?.short ? 4000 : 6000);
    } catch (error) {
      this.log(`ProgressWindow unavailable, falling back to alert: ${error}`);
      try {
        const windows = Zotero.getMainWindows();
        if (windows.length > 0) {
          windows[0].alert(`${operationName}\n\n${detailText}`);
        }
      } catch {
        // Nothing more we can do.
      }
    }
  }

  private log(message: string): void {
    if (typeof Zotero !== "undefined" && Zotero.log) {
      Zotero.log(`Batch Open: ${message}`);
    } else {
      console.log(`Batch Open: ${message}`);
    }
  }
}
