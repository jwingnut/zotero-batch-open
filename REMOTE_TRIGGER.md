# Remote trigger: automating your own "Save" clicks

This is a proof-of-concept pairing of two repos:

- **zotero-batch-open** (this repo) — the Zotero plugin. Publishes a small
  work queue on Zotero's own local HTTP server and applies the results.
- **zotero-connectors**, branch `remote-trigger` — a local fork of the
  official Zotero Connector browser extension. Polls that queue and, for
  each job, performs *exactly* the sequence you would perform by hand:
  open the item's page in a tab, wait for the page to load, click the
  Connector's Save button, close the tab.

Nothing here changes how access is granted, handles any credentials, or
saves anything the Connector couldn't already save with a single click in
your own already-signed-in Chrome. It only removes the manual clicking for
items you've already selected in your own Zotero library.

## Protocol

Zotero's client runs a local HTTP server at `http://127.0.0.1:23119`. The
plugin registers two additional routes on it via `Zotero.Server.Endpoints`
(the same extension point Zotero's own connector server uses):

### `GET /batchopen/queue`

Returns up to 25 pending jobs and marks them "in-flight" for 5 minutes; a
job not resolved within that window is automatically returned to pending
(so a browser crash or a killed tab doesn't strand it forever).

```json
{
  "jobs": [
    {
      "jobId": "job_abc123_xyz",
      "url": "https://doi.org/10.1000/xyz",
      "itemKey": "ABCD1234",
      "libraryID": 1
    }
  ]
}
```

### `POST /batchopen/result`

```json
{
  "jobId": "job_abc123_xyz",
  "ok": true,
  "savedItemKeys": ["EFGH5678"],
  "error": null
}
```

- `ok: true` — for each key in `savedItemKeys`, the plugin moves any
  stored/imported file attachment (a real PDF, not a bare link) from that
  newly saved item onto the *original* item (looked up deterministically
  by `itemKey` + `libraryID` — no title matching), then moves the
  (now-emptied) saved item to the Zotero **trash**. Never a permanent
  delete; recoverable from Zotero's trash like anything else.
- `ok: false` — the job is marked failed and logged with `error`; nothing
  is touched.

Both endpoints, and every enqueue/apply decision, are logged to
`batch-open.log` in the Zotero data directory.

## Enqueueing work

In Zotero, select one or more regular items and use **Batch Open → Save
selected via connector**. For each selected item missing a stored PDF, it
resolves a URL in the same order as "Open all in browser" (stored item URL
→ DOI → first child attachment's URL; no search fallback) and enqueues it.
Nothing happens yet — nothing is fetched until the connector's poller (see
below) is turned on and picks the jobs up.

## Setting up the fork

1. Clone `zotero-connectors`, `git checkout remote-trigger`.
2. `git submodule update --init && npm install`.
3. `cp config.sh-sample config.sh`.
4. Build: `./build.sh -p b` (on Windows without `rsync` on PATH, run the
   equivalent build inside WSL, which has `rsync`; see build notes below).
5. In Chrome: `chrome://extensions` → enable **Developer mode** → **Load
   unpacked** → select `build/manifestv3`.
6. **Disable the official Zotero Connector extension while the fork is
   loaded.** Both extensions would otherwise register content scripts on
   every page and could both try to handle the same save, double-saving
   items or fighting over the toolbar button. Only ever run one at a time.
7. Open the fork's extension options (its own preferences page, Advanced
   pane) → **Batch Open Remote Trigger** → check **Enable the remote-trigger
   queue poller**. It is **off by default**; nothing polls until you check
   this box.

Firefox would additionally need `browser.tabs.create({active:false})`
permission already covered by the extension's existing `tabs` permission,
and the pref UI would appear in the MV2 build's own options page (no other
change — the two extra source files apply to all browser targets built
from this fork, not just Chrome).

## Pacing (mandatory, not configurable off)

| Setting | Default | Why |
|---|---|---|
| Delay between saves | 3000 ms (floor 500 ms) | So the sequence of tab-open → save → tab-close reads as a person clicking through their library, not a script hammering publisher sites. |
| Per-run cap | 50 jobs | Caps how much a single enabled session can do before it stops on its own, so a mistake (e.g. enqueuing your whole library) can't run unbounded. |
| Halt after 3 consecutive failures | — | Stops a broken run (translator not detecting, Zotero closed, network trouble) instead of grinding through every remaining job and failing the same way each time. |
| Poll interval | 4000 ms | How often it checks for new work when idle. |

All four are visible/editable in the fork's Advanced preferences pane
except the failure halt, which is fixed. Tabs are opened inactive
(`active:false`) so they don't steal focus while you keep working.

## Tab readiness signal

The poller does **not** sleep a fixed amount and hope. It reuses the exact
signal `background.js`'s own `_ensureScriptsInjected()` already polls for
Safari: `Zotero.Connector_Browser.getTabInfo(tab.id).translators` being
non-null once the page's injected content script has run translator
detection (`onTranslators()` in `background.js` sets this). The poller
waits up to 20 seconds for that signal (checking every 200ms), then calls
the same `Zotero.Connector_Browser.saveWithTranslator(tab, 0,
{fallbackOnFailure: true})` the toolbar button calls for a manual click.

## Upstream files touched (zotero-connectors, branch `remote-trigger`)

New files (no upstream diff):
- `src/browserExt/batchOpenQueue.js` — the poller itself.

Modified upstream files, kept minimal:
- `src/browserExt/background.js` — **+3 lines**: starts the poller after
  core init, only if the user has enabled it.
- `gulpfile.js` — **+1 line**: adds `batchOpenQueue.js` to the existing
  background-scripts list so it's bundled the same way every other
  background script already is.
- `src/common/zotero.js` — **+6 lines**: four new pref defaults
  (`batchOpenQueue.enabled/delayMs/runCap/pollIntervalMs`), off by default.
- `src/common/messages.js` — **+8 lines**: registers `BatchOpenQueue`
  (`start`/`stop`/`isRunning`/`getLastStopReason`) in the existing
  cross-context messaging table, so the preferences page (a separate JS
  context from the background page) can toggle the poller live.
- `src/common/preferences/preferences.html` — **+13 lines**: one new
  Advanced-pane group (checkbox + two number inputs + a status line).
- `src/common/preferences/preferences.jsx` — **+42 lines**: wires that
  group's inputs and a 2-second status poll.

## Manual test (enqueue two items, watch two tabs)

This has **not** been run against a live Zotero + Chrome — it cannot be
from this environment. Steps to verify it yourself:

1. In Zotero, pick two items you're licensed to access, each missing a
   stored PDF, each with a resolvable URL (item URL, DOI, or a child
   attachment's URL).
2. Select both → **Batch Open → Save selected via connector**. Confirm the
   summary reports "Enqueued 2 item(s)".
3. In Chrome (fork loaded, official Connector disabled), open the fork's
   preferences → Advanced → check **Enable the remote-trigger queue
   poller**.
4. Within ~4 seconds (the poll interval), watch two background tabs open
   (they won't steal focus — check the tab strip), each showing the
   Connector doing its normal save animation, then closing on its own.
   There should be a ~3 second gap between the two.
5. Back in Zotero: both original items should now carry the correct PDF
   attachment (open **View Attachment** to confirm it's the right one, not
   a mismatch). The two Zotero-Connector-created duplicate items should be
   gone from the library view and present in the **Trash** — right-click
   → Restore to confirm they're recoverable, not deleted.
6. Check `batch-open.log` in the Zotero data directory: it should show one
   `POST /batchopen/result ... OK: filesMoved=1 itemsTrashed=1` line per
   item, plus the earlier enqueue lines.
7. Uncheck the poller toggle; confirm no further tabs open even if more
   items are enqueued.

## What is verified vs. what is not

**Verified in this environment** (no Chrome or Zotero client available
here):
- `Zotero.Server.Endpoints` is a real, documented extension point
  (`node_modules/zotero-types/types/xpcom/server.d.ts` in this repo) —
  the registration mechanism itself is not speculative.
- All plugin-side logic (`src/core/queue.ts`, `src/services/queueServer.ts`)
  is unit-tested: 21 new tests covering batching, the abandoned-job
  timeout, failure handling, the file-move-and-trash logic (including that
  a linked-URL attachment is never moved, only stored files), and the
  enqueue resolution order. `npm test` — 148/148 passing.
- `npm run type-check` and `npm run lint:check` pass with the new code.
- The plugin builds (`npm run build`) to a `.xpi` without a version bump.
- The connector fork builds cleanly for Chrome MV3
  (`build/manifestv3`), and `batchOpenQueue.js` is confirmed present in
  the built `background-worker.js`'s import list; all touched/new
  JS files pass `node --check`.

**Not verified — needs a live Chrome + Zotero session**:
- That `Zotero.Server.Endpoints["/batchopen/queue"]` assignment actually
  routes a real HTTP GET to the handler inside a running Zotero client
  (the runtime self-test in `registerQueueServer()` — `selfTestQueueEndpoint()`
  — is written for this and logs PASS/FAIL to `batch-open.log`, but no one
  has read that log from a real run yet).
- That `getTabInfo(tab.id).translators` reliably becomes non-null for
  ordinary publisher pages within the 20-second window, for a newly
  created inactive tab specifically (as opposed to a tab the user
  actively navigated).
- That `saveWithTranslator()`'s resolved value actually carries `.key` for
  every translator type used in practice (confirmed only by reading
  `itemSaver.js`, not by running a save).
- The full manual test above end to end.
