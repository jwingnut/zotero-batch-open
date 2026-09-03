/**
 * Attach this add-on's Fluent bundles to a main window document so
 * `document.l10n.translateFragment` can resolve `data-l10n-id` on MenuManager
 * items. Without this, MenuManager rejects with an unresolvable-l10nID error
 * that surfaces to the user as a bare "Uncaught (in promise) undefined" the
 * moment the item context menu is shown.
 *
 * Do not use `registerChrome` with a 3-element `locale` row — Zotero expects a
 * 4-tuple per locale (`locale`, package, `en-US`, `locale/en-US/`), and the wrong
 * shape throws NS_ERROR_ILLEGAL_VALUE. Loading via insertFTLIfNeeded matches
 * common Zotero plugins and works with the packaged chrome.manifest as-is.
 */

const FTL_STEMS = ["mainWindow", "addon", "preferences"] as const;

export function registerWindowFluent(win: Window): void {
  const ref = addon.data.config.addonRef;
  const moz = (
    win as unknown as {
      MozXULElement?: { insertFTLIfNeeded?: (href: string) => void };
    }
  ).MozXULElement;
  if (typeof moz?.insertFTLIfNeeded !== "function") {
    return;
  }

  for (const stem of FTL_STEMS) {
    const href = `${ref}-${stem}.ftl`;
    try {
      moz.insertFTLIfNeeded(href);
    } catch {
      // Optional bundles (e.g. preferences) may be absent in some builds.
    }
  }
}
