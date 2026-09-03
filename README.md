# Batch Open

A Zotero 10 plugin for opening or searching a batch of selected items in your
browser. Select 10 or 100 items, right-click, and open them all at once.

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

Only regular items are acted on; notes, attachments, and annotations in the
selection are skipped and counted in the summary. Opening more than the
configured threshold prompts for confirmation first, and tabs open with a
short delay between each one so a large batch doesn't arrive all at once (and
Google Scholar doesn't serve a CAPTCHA).

## Settings

Zotero → Settings → Batch Open:

| Setting | Preference key | Default |
|---|---|---|
| Fallback when an item has no usable URL | `extensions.zotero.batchopen.fallback` | `scholar` (`scholar` / `web` / `none`) |
| Web search template | `extensions.zotero.batchopen.searchTemplate` | `https://www.google.com/search?q={query}` |
| Confirm before opening more than N items | `extensions.zotero.batchopen.confirmAbove` | `25` |
| Delay between tabs (ms) | `extensions.zotero.batchopen.delayMs` | `300` |

The web search template must be an `http(s)` URL containing the literal text
`{query}`; an invalid template falls back to the default with a warning.

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
