// Publishes a small work queue on Zotero's existing local HTTP server
// (127.0.0.1:23119) so the zotero-connectors fork's remote-trigger poller
// (see zotero-connectors branch remote-trigger, src/browserExt/batchOpenQueue.js)
// can drive the same "click Save" the user would otherwise do by hand for
// each tab. See REMOTE_TRIGGER.md for the full protocol.
//
// Registration mechanism: Zotero.Server.Endpoints, the same extension point
// Zotero's own connector server (connector/server_connector.js) uses. This
// is documented in zotero-types (node_modules/zotero-types/types/xpcom/server.d.ts)
// so the mechanism itself is not in doubt; what is genuinely unverified
// without a running Zotero is whether *this* registration call executes at
// the right point in plugin startup and survives Zotero's own connector
// server reinitializing. registerQueueServer() is therefore defensive: it
// verifies the assignment took (reads the property back) and then runs an
// actual loopback HTTP self-test, logging a loud, unambiguous PASS/FAIL
// line either way.

import { splitSelection } from "@/core/selection";
import { hasStoredPdf, isFileAttachment, type AttachmentRef } from "@/core/attachments";
import { resolveOpenUrl } from "@/core/urlResolution";
import { JobQueue, type QueuedJob } from "@/core/queue";
import { appendLogLine } from "@/utils/fileLog";

/** Max jobs handed out per GET /batchopen/queue call. */
export const DEFAULT_BATCH_SIZE = 25;

const QUEUE_PATH = "/batchopen/queue";
const RESULT_PATH = "/batchopen/result";
const CONNECTOR_PORT = 23119;

export interface ResultPayload {
  jobId: string;
  ok: boolean;
  savedItemKeys?: string[];
  error?: string;
}

function log(message: string): void {
  const line = `QueueServer: ${message}`;
  try {
    if (typeof Zotero !== "undefined" && Zotero.log) {
      Zotero.log(`Batch Open: ${line}`);
    } else {
      console.log(`Batch Open: ${line}`);
    }
  } catch {
    // Never let logging itself throw.
  }
  appendLogLine(line);
}

/** Module-scope singleton: one queue for the life of the Zotero session. */
export const jobQueue = new JobQueue();

// ---------------------------------------------------------------------
// Endpoint registration
// ---------------------------------------------------------------------

/**
 * Minimal shape of the `Zotero.Server.Endpoints` map this module needs —
 * kept narrow (rather than importing the full ambient `Zotero` type) so the
 * registration logic can be unit tested against a fake.
 */
export interface EndpointRegistry {
  [path: string]: unknown;
}

export interface RegisterResult {
  registered: boolean;
  reason?: string;
}

/**
 * Registers the two endpoints. Returns whether the registry accepted both
 * assignments (verified by reading them back) — it does NOT by itself prove
 * the HTTP server will route to them; call `selfTestQueueEndpoint()`
 * afterward for that.
 */
export function registerEndpointsOnRegistry(
  registry: EndpointRegistry | undefined | null,
): RegisterResult {
  if (!registry || typeof registry !== "object") {
    return {
      registered: false,
      reason: "Zotero.Server.Endpoints is not available (undefined or not an object)",
    };
  }

  try {
    registry[QUEUE_PATH] = QueueEndpoint;
    registry[RESULT_PATH] = ResultEndpoint;
  } catch (error) {
    return {
      registered: false,
      reason: `assignment threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const queueOk = registry[QUEUE_PATH] === QueueEndpoint;
  const resultOk = registry[RESULT_PATH] === ResultEndpoint;
  if (!queueOk || !resultOk) {
    return {
      registered: false,
      reason: `read-back mismatch (queue=${queueOk}, result=${resultOk}); another plugin may have overwritten the same path`,
    };
  }

  return { registered: true };
}

/**
 * Registers the endpoints against the live `Zotero.Server.Endpoints`
 * object, logs the outcome loudly either way, and — on success — schedules
 * a real loopback HTTP self-test so a routing failure (as opposed to a mere
 * registration failure) is also caught and logged.
 */
export function registerQueueServer(): void {
  let registry: EndpointRegistry | undefined;
  try {
    registry = (Zotero as unknown as { Server?: { Endpoints?: EndpointRegistry } })
      .Server?.Endpoints;
  } catch (error) {
    log(
      `ENDPOINT REGISTRATION FAILED: reading Zotero.Server.Endpoints threw: ${error}. ` +
        `The remote trigger is UNAVAILABLE — "Save selected via connector" will enqueue jobs ` +
        `that nothing can ever fetch.`,
    );
    return;
  }

  const result = registerEndpointsOnRegistry(registry);
  if (!result.registered) {
    log(
      `ENDPOINT REGISTRATION FAILED: ${result.reason}. The remote trigger is UNAVAILABLE — ` +
        `"Save selected via connector" will enqueue jobs that nothing can ever fetch.`,
    );
    return;
  }

  log(`Registered ${QUEUE_PATH} and ${RESULT_PATH} on Zotero.Server.Endpoints.`);

  // Give Zotero's HTTP server a moment to be listening (it may not be up
  // yet this early in startup), then confirm the route actually answers.
  setTimeout(() => {
    void selfTestQueueEndpoint();
  }, 5000);
}

/**
 * Performs a real GET http://127.0.0.1:<port>/batchopen/queue and checks
 * for a well-formed response. This is the only way to know the endpoint is
 * truly reachable (registration can "succeed" against the map while the
 * server itself is down, on a different port, or blocking the request).
 */
export async function selfTestQueueEndpoint(
  port: number = CONNECTOR_PORT,
): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}${QUEUE_PATH}`, {
      method: "GET",
    });
    if (!resp.ok) {
      log(`SELF-TEST FAILED: GET ${QUEUE_PATH} returned HTTP ${resp.status}.`);
      return false;
    }
    const body = await resp.json();
    if (!body || !Array.isArray((body as { jobs?: unknown }).jobs)) {
      log(
        `SELF-TEST FAILED: GET ${QUEUE_PATH} returned 200 but with an unexpected body shape: ` +
          `${JSON.stringify(body)}`,
      );
      return false;
    }
    log(`SELF-TEST PASSED: GET ${QUEUE_PATH} is reachable and returns {jobs:[...]}.`);
    return true;
  } catch (error) {
    log(
      `SELF-TEST FAILED: GET ${QUEUE_PATH} threw (server likely not listening, or blocked): ${error}. ` +
        `The remote trigger is UNAVAILABLE.`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------
// GET /batchopen/queue
// ---------------------------------------------------------------------

export const QueueEndpoint = function (this: unknown) {} as unknown as {
  new (): { init: (options: unknown) => Promise<[number, string, string]> };
};

QueueEndpoint.prototype = {
  supportedMethods: ["GET"],
  permitBookmarklet: false,

  init: async function (): Promise<[number, string, string]> {
    try {
      const jobs: QueuedJob[] = jobQueue.takeBatch(DEFAULT_BATCH_SIZE);
      log(`GET ${QUEUE_PATH} -> ${jobs.length} job(s) handed out`);
      return [200, "application/json", JSON.stringify({ jobs })];
    } catch (error) {
      log(`GET ${QUEUE_PATH} handler threw: ${error}`);
      return [500, "application/json", JSON.stringify({ error: String(error) })];
    }
  },
};

// ---------------------------------------------------------------------
// POST /batchopen/result
// ---------------------------------------------------------------------

/** The subset of Zotero.Item this module needs — kept narrow for testability. */
export interface ResultItemLookup {
  getByLibraryAndKey(libraryID: number, key: string): ZoteroItemLike | false;
}

export interface ZoteroItemLike extends AttachmentRef {
  id: number;
  key: string;
  libraryID: number;
  parentID?: number | false;
  isRegularItem(): boolean;
  getAttachments(): number[];
  saveTx(): Promise<unknown>;
}

export interface ApplyResultDeps {
  items: ResultItemLookup;
  getItem(id: number): ZoteroItemLike | null;
  trash(id: number): Promise<unknown>;
  linkedUrlLinkMode: number;
}

export interface ApplyResultOutcome {
  ok: boolean;
  filesMoved: number;
  itemsTrashed: number;
  error?: string;
}

/**
 * The result-handling logic, factored out from the Zotero.Server.Endpoint
 * wrapper so it's unit-testable against fakes. On success: reparents every
 * stored/imported file attachment from each saved item onto the original
 * (looked up deterministically by itemKey/libraryID — no title matching),
 * then trashes the (now-emptied) saved item. Never permanently deletes.
 */
export async function applyResult(
  payload: ResultPayload,
  deps: ApplyResultDeps,
): Promise<ApplyResultOutcome> {
  const job = jobQueue.get(payload.jobId);
  if (!job) {
    const msg = `unknown jobId ${payload.jobId}`;
    log(`POST ${RESULT_PATH} ${msg}`);
    return { ok: false, filesMoved: 0, itemsTrashed: 0, error: msg };
  }

  if (!payload.ok) {
    jobQueue.fail(payload.jobId, payload.error || "connector reported failure");
    log(
      `POST ${RESULT_PATH} jobId=${payload.jobId} itemKey=${job.itemKey} FAILED: ${payload.error || "(no reason given)"}`,
    );
    return { ok: false, filesMoved: 0, itemsTrashed: 0, error: payload.error };
  }

  try {
    const original = deps.items.getByLibraryAndKey(job.libraryID, job.itemKey);
    if (!original) {
      throw new Error(
        `original item not found for libraryID=${job.libraryID} itemKey=${job.itemKey}`,
      );
    }

    let filesMoved = 0;
    let itemsTrashed = 0;
    const savedKeys = payload.savedItemKeys || [];

    for (const savedKey of savedKeys) {
      const saved = deps.items.getByLibraryAndKey(job.libraryID, savedKey);
      if (!saved) {
        log(
          `POST ${RESULT_PATH} jobId=${payload.jobId}: saved item key=${savedKey} not found; skipping`,
        );
        continue;
      }

      const attachmentIds = saved.getAttachments();
      for (const attId of attachmentIds) {
        const attachment = deps.getItem(attId);
        if (!attachment || !isFileAttachment(attachment, deps.linkedUrlLinkMode)) {
          continue;
        }
        attachment.parentID = original.id;
        await attachment.saveTx();
        filesMoved += 1;
      }

      await deps.trash(saved.id);
      itemsTrashed += 1;
    }

    jobQueue.complete(payload.jobId);
    log(
      `POST ${RESULT_PATH} jobId=${payload.jobId} itemKey=${job.itemKey} OK: ` +
        `filesMoved=${filesMoved} itemsTrashed=${itemsTrashed}`,
    );
    return { ok: true, filesMoved, itemsTrashed };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    jobQueue.fail(payload.jobId, msg);
    log(`POST ${RESULT_PATH} jobId=${payload.jobId} itemKey=${job.itemKey} error applying result: ${msg}`);
    return { ok: false, filesMoved: 0, itemsTrashed: 0, error: msg };
  }
}

function liveApplyResultDeps(): ApplyResultDeps {
  const ZoteroItems = Zotero.Items as unknown as ResultItemLookup & {
    get(id: number): ZoteroItemLike | false;
  };
  return {
    items: ZoteroItems,
    getItem: (id: number) => {
      const item = ZoteroItems.get(id);
      return item ? item : null;
    },
    trash: (id: number) => (Zotero.Items as unknown as { trash(id: number): Promise<unknown> }).trash(id),
    linkedUrlLinkMode: (() => {
      try {
        const value = (Zotero.Attachments as unknown as { LINK_MODE_LINKED_URL?: number })
          ?.LINK_MODE_LINKED_URL;
        return typeof value === "number" ? value : 3;
      } catch {
        return 3;
      }
    })(),
  };
}

export const ResultEndpoint = function (this: unknown) {} as unknown as {
  new (): { init: (options: { data?: unknown }) => Promise<[number, string, string]> };
};

ResultEndpoint.prototype = {
  supportedMethods: ["POST"],
  supportedDataTypes: ["application/json"],
  permitBookmarklet: false,

  init: async function (options: { data?: unknown }): Promise<[number, string, string]> {
    try {
      const payload = options?.data as ResultPayload | undefined;
      if (!payload || typeof payload.jobId !== "string") {
        return [400, "application/json", JSON.stringify({ error: "missing jobId" })];
      }
      const outcome = await applyResult(payload, liveApplyResultDeps());
      return [200, "application/json", JSON.stringify(outcome)];
    } catch (error) {
      log(`POST ${RESULT_PATH} handler threw: ${error}`);
      return [500, "application/json", JSON.stringify({ error: String(error) })];
    }
  },
};

// ---------------------------------------------------------------------
// Enqueueing from the "Save selected via connector" menu command
// ---------------------------------------------------------------------

export interface EnqueueSelectableItem extends AttachmentRef {
  isRegularItem(): boolean;
  key?: string;
  libraryID: number;
  getField(field: string): string;
  getAttachments(): number[];
}

export interface EnqueueItemLookup {
  get(id: number): (EnqueueSelectableItem & AttachmentRef) | null;
}

export interface EnqueueResult {
  enqueued: number;
  skippedHasPdf: number;
  skippedNoUrl: number;
  skippedNotRegular: number;
}

/**
 * For each selected regular item with no stored PDF, resolve a URL using
 * the same order as "Open all in browser" (stored url -> DOI -> first
 * attachment url; no search fallback — there is nothing useful to save from
 * a search results page) and enqueue it. Returns counts for the on-screen
 * summary.
 */
export function enqueueSelectedItems(
  selected: EnqueueSelectableItem[],
  itemLookup: EnqueueItemLookup,
  linkedUrlLinkMode: number,
): EnqueueResult {
  const { regularItems, skippedCount: skippedNotRegular } = splitSelection(selected);

  let enqueued = 0;
  let skippedHasPdf = 0;
  let skippedNoUrl = 0;

  for (const item of regularItems) {
    if (!item.key) {
      // Not yet saved (no persistent key) — nothing stable to reconcile
      // the connector's result back onto later; skip it rather than guess.
      skippedNoUrl += 1;
      continue;
    }

    const attachments = item
      .getAttachments()
      .map((id) => itemLookup.get(id))
      .filter((a): a is EnqueueSelectableItem & AttachmentRef => !!a);

    if (hasStoredPdf(attachments, linkedUrlLinkMode)) {
      skippedHasPdf += 1;
      continue;
    }

    const resolved = resolveOpenUrl(item, itemLookup, {
      fallback: "none",
      searchQuery: "",
      webTemplate: "",
    });

    if (!resolved.url) {
      skippedNoUrl += 1;
      continue;
    }

    jobQueue.enqueue({
      url: resolved.url,
      itemKey: item.key,
      libraryID: item.libraryID,
    });
    enqueued += 1;
  }

  return { enqueued, skippedHasPdf, skippedNoUrl, skippedNotRegular };
}
