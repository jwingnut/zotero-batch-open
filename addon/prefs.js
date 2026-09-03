// Batch Open default preferences

// Fallback used when an item has no usable URL: "scholar" | "web" | "none"
pref("extensions.zotero.batchopen.fallback", "scholar");

// Web search template. {query} is replaced with the URL-encoded search terms.
pref(
  "extensions.zotero.batchopen.searchTemplate",
  "https://www.google.com/search?q={query}",
);

// Ask for confirmation before opening more than this many items at once.
pref("extensions.zotero.batchopen.confirmAbove", 25);

// Delay in milliseconds between opening each tab.
pref("extensions.zotero.batchopen.delayMs", 300);

// How many minutes back to look for connector-created duplicates when
// reconciling ("Attach newly saved files to the selected items").
pref("extensions.zotero.batchopen.reconcileWindowMinutes", 120);

// Whether "Save selected via connector" automatically reconciles: moves the
// saved file onto the original item and trashes the new duplicate. Off
// leaves the new item as-is for a duplicate-merging plugin (e.g. Zoplicate)
// to handle instead. See queueServer.ts's reconcileInBackground().
pref("extensions.zotero.batchopen.reconcileSavedItems", true);

// How long (ms) reconciliation waits, polling in the background, for a
// newly connector-saved item to gain a stored file attachment before giving
// up and falling back to duplicate matching.
pref("extensions.zotero.batchopen.attachmentWaitMs", 60000);
