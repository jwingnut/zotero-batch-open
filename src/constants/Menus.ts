// src/constants/Menus.ts

/**
 * XUL namespace for creating XUL elements
 */
export const XUL_NAMESPACE =
  "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

/**
 * Platform version threshold for createXULElement support
 * Zotero 102+ (Firefox 102+) supports document.createXULElement
 */
export const PLATFORM_VERSION_CREATE_XUL = 102;

/**
 * Menu parent IDs
 */
export const MenuParentID = {
  ITEM_CONTEXT: "zotero-itemmenu",
} as const;

/** Parent submenu for the three batch commands (Zotero 8+ MenuManager). */
export const LIBRARY_ITEM_SUBMENU_L10N_ID = "batchopen-submenu" as const;

/**
 * Fluent IDs for Zotero 8+ MenuManager (main/library/item).
 * Must match keys in addon/locale/en-US/mainWindow.ftl with a `.label` attribute.
 */
export const LIBRARY_ITEM_MENU_L10N_IDS = [
  "batchopen-menu-open-browser",
  "batchopen-menu-search-scholar",
  "batchopen-menu-search-web",
  "batchopen-menu-open-browser-missing-pdf",
  "batchopen-menu-reconcile-attachments",
  "batchopen-menu-save-via-connector",
] as const;

/** Fallback labels if Fluent is not bound (legacy / tests). */
export const LIBRARY_ITEM_MENU_LABELS = [
  "Open all in browser",
  "Search all in Google Scholar",
  "Search all in web search",
  "Open all in browser (only those missing a PDF)",
  "Attach newly saved files to the selected items",
  "Save selected via connector",
] as const;

/** Submenu fallback label. */
export const SUBMENU_LABEL = "Batch Open" as const;
