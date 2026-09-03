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
// verifies the assignment took (reads the property back) and logs the
// outcome loudly either way. It does NOT run its own loopback fetch() as a
// self-test — Zotero blocks that kind of internal-to-itself request, so an
// earlier version of this file logged a false "UNAVAILABLE" verdict even
// while the real client (the browser connector) was fetching the endpoint
// successfully. See registerQueueServer() below.

import { splitSelection } from "@/core/selection";
import {
  hasStoredPdf,
  isFileAttachment,
  type AttachmentRef,
} from "@/core/attachments";
import { resolveOpenUrl } from "@/core/urlResolution";
import { JobQueue, type QueuedJob } from "@/core/queue";
import { appendLogLine } from "@/utils/fileLog";

/** Max jobs handed out per GET /batchopen/queue call. */
export const DEFAULT_BATCH_SIZE = 25;

const QUEUE_PATH = "/batchopen/queue";
const RESULT_PATH = "/batchopen/result";

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
 * the HTTP server will route to them, and there is no reliable in-process
 * self-test for that (see the note at the top of this file); the browser
 * connector's first successful poll is the real confirmation.
 */
export function registerEndpointsOnRegistry(
  registry: EndpointRegistry | undefined | null,
): RegisterResult {
  if (!registry || typeof registry !== "object") {
    return {
      registered: false,
      reason:
        "Zotero.Server.Endpoints is not available (undefined or not an object)",
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
 * object and logs the outcome loudly either way. On success this logs a
 * plain factual line rather than a self-test verdict (see file header) —
 * the browser connector's first `GET /batchopen/queue` is what actually
 * proves the route is reachable.
 */
export function registerQueueServer(): void {
  let registry: EndpointRegistry | undefined;
  try {
    registry = (
      Zotero as unknown as { Server?: { Endpoints?: EndpointRegistry } }
    ).Server?.Endpoints;
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

  log(
    `Registered ${QUEUE_PATH} and ${RESULT_PATH} on Zotero.Server.Endpoints.`,
  );
  log(
    "Registration succeeded; awaiting the first poll from the browser connector. " +
      "(A prior version of this line ran its own loopback fetch() as a self-test; " +
      "Zotero blocks that request internally, so it always reported the endpoint " +
      "as unreachable even while external clients — the actual browser connector — " +
      "were fetching it successfully. That self-test has been removed rather than " +
      "trusted.)",
  );
}

// ---------------------------------------------------------------------
// GET /batchopen/queue
// ---------------------------------------------------------------------

export interface QueueEndpointOptions {
  query?: unknown;
}

export const QueueEndpoint = function (this: unknown) {} as unknown as {
  new (): {
    init: (options: QueueEndpointOptions) => Promise<[number, string, string]>;
  };
};

/**
 * Extracts the raw `max` value out of whatever shape Zotero.Server actually
 * hands the endpoint as `options.query`.
 *
 * The documented/actual shape (zotero-types' server.d.ts, matching Zotero's
 * own dispatch in Zotero.Server.DataListener.prototype._processEndpoint --
 * `query: this.query ? Zotero.Server.decodeQueryString(this.query.substr(1))
 * : {}`, see zotero-connectors' vendored src/zotero/chrome/content/zotero/
 * xpcom/server.js) is a plain `Record<string, string>` with an unprefixed
 * key ("max", not "?max"). This is deliberately tolerant of other shapes
 * anyway -- a raw query string, a URLSearchParams-like object, a repeated
 * parameter arriving as an array, or a key that still carries its leading
 * "?" -- so that a shape this endpoint doesn't anticipate is treated the
 * same as "no ?max given" (batchSize falls back to the default, i.e. no
 * limit) rather than ever being misread as "?max=0" and silently returning
 * no jobs.
 */
export function extractMaxParam(
  options: QueueEndpointOptions,
): string | undefined {
  const query = options?.query;
  if (query === undefined || query === null) {
    return undefined;
  }

  // A raw query string, e.g. "max=1" or "?max=1".
  if (typeof query === "string") {
    const stripped = query.startsWith("?") ? query.slice(1) : query;
    const value = new URLSearchParams(stripped).get("max");
    return value === null ? undefined : value;
  }

  // A URLSearchParams (or URLSearchParams-like) object.
  if (
    typeof query === "object" &&
    typeof (query as { get?: unknown }).get === "function"
  ) {
    const value = (query as URLSearchParams).get("max");
    return value === null || value === undefined ? undefined : String(value);
  }

  // A plain object -- the documented/actual shape -- tolerant of a key that
  // still carries a leading "?" and of a value that arrived as an array
  // (e.g. from a repeated query parameter; the first value wins).
  if (typeof query === "object") {
    const record = query as Record<string, unknown>;
    let value: unknown = record.max;
    if (value === undefined) {
      value = record["?max"];
    }
    if (Array.isArray(value)) {
      value = value[0];
    }
    return value === undefined || value === null ? undefined : String(value);
  }

  return undefined;
}

QueueEndpoint.prototype = {
  supportedMethods: ["GET"],
  permitBookmarklet: false,

  // A poller that wakes for a single bounded unit of work at a time (as the
  // zotero-connectors MV3 poller now does, to survive service-worker
  // eviction) can pass ?max=1 to avoid claiming a full batch of jobs it has
  // no intention of processing before its next wake.
  init: async function (
    options: QueueEndpointOptions,
  ): Promise<[number, string, string]> {
    try {
      let batchSize = DEFAULT_BATCH_SIZE;
      const rawMax = extractMaxParam(options);
      if (rawMax !== undefined) {
        const parsed = Number.parseInt(rawMax, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          batchSize = Math.min(parsed, DEFAULT_BATCH_SIZE);
        }
        // else: rawMax was present but unparseable (NaN, "0", negative,
        // non-numeric) -- fall through with the default batch size (i.e.
        // "no limit") rather than ever treating a parse failure as "hand out
        // zero jobs".
      }
      const jobs: QueuedJob[] = jobQueue.takeBatch(batchSize);
      // Log every poll, including one that yields nothing, so a request
      // that arrived but had no jobs to hand out (queue empty, or every
      // pending job already claimed/in-flight) is distinguishable in
      // batch-open.log from no request having arrived at all.
      log(
        `GET ${QUEUE_PATH} -> ${jobs.length} job(s) handed out ` +
          `(max=${rawMax ?? "(none)"}, batchSize=${batchSize}, ` +
          `pending=${jobQueue.pendingCount()}, inFlight=${jobQueue.inFlightCount()})`,
      );
      return [200, "application/json", JSON.stringify({ jobs })];
    } catch (error) {
      log(`GET ${QUEUE_PATH} handler threw: ${error}`);
      return [
        500,
        "application/json",
        JSON.stringify({ error: String(error) }),
      ];
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
        if (
          !attachment ||
          !isFileAttachment(attachment, deps.linkedUrlLinkMode)
        ) {
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
    log(
      `POST ${RESULT_PATH} jobId=${payload.jobId} itemKey=${job.itemKey} error applying result: ${msg}`,
    );
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
    trash: (id: number) =>
      (
        Zotero.Items as unknown as { trash(id: number): Promise<unknown> }
      ).trash(id),
    linkedUrlLinkMode: (() => {
      try {
        const value = (
          Zotero.Attachments as unknown as { LINK_MODE_LINKED_URL?: number }
        )?.LINK_MODE_LINKED_URL;
        return typeof value === "number" ? value : 3;
      } catch {
        return 3;
      }
    })(),
  };
}

export const ResultEndpoint = function (this: unknown) {} as unknown as {
  new (): {
    init: (options: { data?: unknown }) => Promise<[number, string, string]>;
  };
};

ResultEndpoint.prototype = {
  supportedMethods: ["POST"],
  supportedDataTypes: ["application/json"],
  permitBookmarklet: false,

  init: async function (options: {
    data?: unknown;
  }): Promise<[number, string, string]> {
    try {
      const payload = options?.data as ResultPayload | undefined;
      if (!payload || typeof payload.jobId !== "string") {
        return [
          400,
          "application/json",
          JSON.stringify({ error: "missing jobId" }),
        ];
      }
      const outcome = await applyResult(payload, liveApplyResultDeps());
      return [200, "application/json", JSON.stringify(outcome)];
    } catch (error) {
      log(`POST ${RESULT_PATH} handler threw: ${error}`);
      return [
        500,
        "application/json",
        JSON.stringify({ error: String(error) }),
      ];
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
  skippedAlreadyQueued: number;
}

/**
 * For each selected regular item with no stored PDF, resolve a URL using
 * the same order as "Open all in browser" (stored url -> DOI -> first
 * attachment url; no search fallback — there is nothing useful to save from
 * a search results page) and enqueue it. Returns counts for the on-screen
 * summary.
 *
 * Deduplicates on (libraryID, itemKey): an item that already has a pending
 * or in-flight job is skipped rather than enqueued again, so re-running
 * this command on the same selection (e.g. because the connector poller
 * had not yet started) does not pile up duplicate jobs for the same item.
 */
export function enqueueSelectedItems(
  selected: EnqueueSelectableItem[],
  itemLookup: EnqueueItemLookup,
  linkedUrlLinkMode: number,
): EnqueueResult {
  const { regularItems, skippedCount: skippedNotRegular } =
    splitSelection(selected);

  let enqueued = 0;
  let skippedHasPdf = 0;
  let skippedNoUrl = 0;
  let skippedAlreadyQueued = 0;

  for (const item of regularItems) {
    if (!item.key) {
      // Not yet saved (no persistent key) — nothing stable to reconcile
      // the connector's result back onto later; skip it rather than guess.
      skippedNoUrl += 1;
      continue;
    }

    if (jobQueue.hasActiveJobForItem(item.libraryID, item.key)) {
      skippedAlreadyQueued += 1;
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

  return {
    enqueued,
    skippedHasPdf,
    skippedNoUrl,
    skippedNotRegular,
    skippedAlreadyQueued,
  };
}

// ---------------------------------------------------------------------
// "Clear the connector queue" menu command
// ---------------------------------------------------------------------

export interface ClearQueueResult {
  pendingCleared: number;
  inFlightCleared: number;
  totalCleared: number;
}

/** Empties pending and in-flight jobs so a stuck queue is recoverable without restarting Zotero. */
export function clearConnectorQueue(): ClearQueueResult {
  const { pendingCleared, inFlightCleared } = jobQueue.clear();
  const totalCleared = pendingCleared + inFlightCleared;
  log(
    `Cleared connector queue: pending=${pendingCleared} in-flight=${inFlightCleared} total=${totalCleared}`,
  );
  return { pendingCleared, inFlightCleared, totalCleared };
}
