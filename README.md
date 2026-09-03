<img src="addon/icons/batch-open-128.png" alt="" width="96" align="right">

# Batch Open

A Zotero 10 plugin for opening or searching a batch of selected items in your
browser. Select 10 or 100 items, right-click, and open them all at once.

**[Download the latest .xpi](https://github.com/jwingnut/zotero-batch-open/releases/latest)** —
then in Zotero: Tools → Add-ons → gear → Install Add-on From File.

## Commands

Right-click a selection of items in your Zotero library (item context menu,
under the **Batch Open** submenu):

1. **Open all in browser** — for each selected item, opens its URL. Resolution
   order: the item's own `url` field; else its DOI as `https://doi.org/<doi>`
   (a stored DOI that already includes a resolver prefix, or a `doi:` scheme,
   is normalized first); else the URL of the first child attachment that has
   one; else the configured fallback (Google Scholar search, web search, or
   skip).
2. **Search all in Google Scholar** — opens a Google Scholar search for each
   item (title, first author's family name, and year), ignoring any stored
   URL.
3. **Search all in web search** — same, using your configured web search
   engine template.
4. **Open all in browser (only those missing a PDF)** — same as command 1,
   but first drops any selected item that already has a stored/imported PDF
   attachment (a linked-URL attachment doesn't count as "having" the PDF).
   The summary reports how many were skipped for already having one.
5. **Attach newly saved files to the selected items** — reconciles items the
   Zotero Connector just saved as new top-level duplicates (see "How the
   workflow fits together" below). For each selected item (the originals),
   it looks for a duplicate top-level item added to the same library within
   the last N minutes (configurable) and matches it by, in order: normalized
   DOI; PMID/arXiv id (from the Extra field); or a close title match plus the
   same year. On a match, every stored/imported file attachment (PDFs and
   snapshots — not linked-URL attachments) is moved from the duplicate onto
   the original, and the now-empty duplicate is moved to the **trash**
   (never permanently deleted — this is reversible from Zotero's trash). An
   original's existing attachments are never touched; if both the original
   and the duplicate already had a stored PDF, both are kept and the summary
   says so. This command always asks for confirmation first, naming exactly
   how many files will be attached and how many duplicates will be trashed.

## How the workflow fits together

UC Davis library access is only available through a browser session on the
VPN, so this plugin never downloads anything itself. The intended loop is:

1. Select items missing a PDF and run **Open all in browser (only those
   missing a PDF)** to open just the tabs that need saving.
2. Press the Zotero Connector's save button on each tab. The connector saves
   each page as a new top-level item with the PDF attached, rather than
   attaching it to the item you already had.
3. Re-select the original items and run **Attach newly saved files to the
   selected items** to move each connector-created PDF onto the original and
   send the now-empty duplicate to the trash.

Only regular items are acted on; notes, attachments, and annotations in the
selection are skipped and counted in the summary. Opening more than the
configured threshold prompts for confirmation first, and tabs open with a
short delay between each one so a large batch doesn't arrive all at once (and
Google Scholar doesn't serve a CAPTCHA).

## Settings

Zotero → Settings → Batch Open:

| Setting                                  | Preference key                                       | Default                                   |
| ---------------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| Fallback when an item has no usable URL  | `extensions.zotero.batchopen.fallback`               | `scholar` (`scholar` / `web` / `none`)    |
| Web search template                      | `extensions.zotero.batchopen.searchTemplate`         | `https://www.google.com/search?q={query}` |
| Confirm before opening more than N items | `extensions.zotero.batchopen.confirmAbove`           | `25`                                      |
| Delay between tabs (ms)                  | `extensions.zotero.batchopen.delayMs`                | `300`                                     |
| Reconcile window (minutes)               | `extensions.zotero.batchopen.reconcileWindowMinutes` | `120`                                     |

The web search template must be an `http(s)` URL containing the literal text
`{query}`; an invalid template falls back to the default with a warning. The
reconcile window controls how far back "Attach newly saved files to the
selected items" looks for a connector-created duplicate to merge.

Every reconcile match decision (which items, which rule matched, similarity
where relevant, and what moved) is logged to `batch-open.log` in the Zotero
data directory, so a merge can be reconstructed after the fact.

## Installing the xpi

1. Run `npm install && npm run build`. This produces
   `.scaffold/dist/batch-open.xpi`.
2. In Zotero 10: **Tools → Add-ons**, click the gear icon, choose
   **Install Add-on From File...**, and select the `.xpi`.

## Development

```
npm install
npm run build        # zotero-plugin build + tsc --noEmit
npm test              # vitest
npm run lint:check    # prettier --check + eslint
```

Built from the [zotero-zotadata](https://github.com/ydeng11/zotero-zotadata)
scaffold: same `zotero-plugin-scaffold` build setup, the same
MenuManager-with-legacy-XUL-fallback approach to context-menu registration,
and the same `PreferencePanes.register` pattern for the settings pane.
