/**
 * Attach this add-on's Fluent bundles to a main window document so
 * `document.l10n.translateFragment` can resolve `data-l10n-id` on MenuManager
 * items. Without this, MenuManager rejects with an unresolvable-l10nID error
 * that surfaces to the user as a bare "Uncaught (in promise) undefined" the
 * moment the item context menu is shown.
 *
 * As of 0.1.4 the item context menu itself no longer depends on this (menu
 * labels are set directly in `onShowing`, with `l10nID` used only as a
 * fallback registration path) — this remains for the preferences pane, which
 * still resolves labels via Fluent.
 *
 * Do not use `registerChrome` with a 3-element `locale` row — Zotero expects a
 * 4-tuple per locale (`locale`, package, `en-US`, `locale/en-US/`), and the wrong
 * shape throws NS_ERROR_ILLEGAL_VALUE. Loading via insertFTLIfNeeded matches
 * common Zotero plugins and works with the packaged chrome.manifest as-is.
 */

import { appendLogLine } from "@/utils/fileLog";

const FTL_STEMS = ["mainWindow", "addon", "preferences"] as const;
const DEFAULT_LOCALE = "en-US";

export function registerWindowFluent(win: Window): void {
  const ref = addon.data.config.addonRef;
  const moz = (
    win as unknown as {
      MozXULElement?: { insertFTLIfNeeded?: (href: string) => void };
    }
  ).MozXULElement;
  if (typeof moz?.insertFTLIfNeeded !== "function") {
    appendLogLine(
      "Fluent: MozXULElement.insertFTLIfNeeded unavailable; skipping bundle insertion",
    );
    return;
  }

  for (const stem of FTL_STEMS) {
    const href = `${ref}-${stem}.ftl`;
    try {
      moz.insertFTLIfNeeded(href);
      appendLogLine(`Fluent insert attempt: ${href} threw=false`);
    } catch (error) {
      // Optional bundles (e.g. preferences) may be absent in some builds.
      appendLogLine(`Fluent insert attempt: ${href} threw=true error=${error}`);
    }
  }
}

type LocaleServices = {
  locale?: {
    appLocaleAsBCP47?: string;
  };
};

function getTrimmedLocale(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

/**
 * The app locale in play, for logging. Prefers `Zotero.locale`, then
 * `Services.locale.appLocaleAsBCP47`, and falls back to "en-US" (mirrors
 * zotero-zotadata's `src/utils/locale.ts`).
 */
export function getPreferredLocale(): string {
  const runtime = globalThis as typeof globalThis & {
    Services?: LocaleServices;
    Zotero?: typeof Zotero & {
      // Zotero.locale is sometimes an object ({ locale: "en-US" }) rather
      // than a plain string across different Zotero versions;
      // getTrimmedLocale returns null for non-string values.
      locale?: string;
    };
  };

  const zoteroLocale = getTrimmedLocale(runtime.Zotero?.locale);
  if (zoteroLocale) {
    return zoteroLocale;
  }

  const appLocale = getTrimmedLocale(
    runtime.Services?.locale?.appLocaleAsBCP47,
  );
  if (appLocale) {
    return appLocale;
  }

  return DEFAULT_LOCALE;
}
