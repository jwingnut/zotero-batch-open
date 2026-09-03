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
import {
  isKnownRedirectorUrl,
  resolveRedirectorUrl,
} from "@/core/redirectResolver";
import { JobQueue, type QueuedJob, type Job } from "@/core/queue";
import type { MatchRule } from "@/core/duplicateMatch";
import {
  selectCandidates,
  planReconciliation,
  parseZoteroDateAddedMs,
  resolveAllItems,
} from "@/core/reconcile";
import { appendLogLine } from "@/utils/fileLog";

/** Max jobs handed out per GET /batchopen/queue call. */
export const DEFAULT_BATCH_SIZE = 25;

const QUEUE_PATH = "/batchopen/queue";
const RESULT_PATH = "/batchopen/result";
const STATUS_PATH = "/batchopen/status";

export interface ResultPayload {
  jobId: string;
  ok: boolean;
  savedItemKeys?: string[];
  error?: string;
  /**
   * Free-text diagnostics from the connector (redirect trail, which
   * save path was used -- translator/PDF/snapshot, etc.). See
   * batchOpenQueue.js's _reportResult(). Purely for the log.
   */
  detail?: string;
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
    registry[STATUS_PATH] = StatusEndpoint;
  } catch (error) {
    return {
      registered: false,
      reason: `assignment threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const queueOk = registry[QUEUE_PATH] === QueueEndpoint;
  const resultOk = registry[RESULT_PATH] === ResultEndpoint;
  const statusOk = registry[STATUS_PATH] === StatusEndpoint;
  if (!queueOk || !resultOk || !statusOk) {
    return {
      registered: false,
      reason: `read-back mismatch (queue=${queueOk}, result=${resultOk}, status=${statusOk}); another plugin may have overwritten the same path`,
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
    `Registered ${QUEUE_PATH}, ${RESULT_PATH}, and ${STATUS_PATH} on Zotero.Server.Endpoints.`,
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
// GET /batchopen/status
// ---------------------------------------------------------------------

/**
 * Read-only queue depth for the connector's preferences pane -- unlike
 * GET /batchopen/queue, this never claims a job. Added so a poller that has
 * stopped (for any reason) still shows waiting work at a glance instead of
 * looking identical to "nothing queued" (see the 2026-09 incident this was
 * added for: a halted poller with jobs piling up looked, from the options
 * page, exactly like a working poller with nothing to do).
 */
export const StatusEndpoint = function (this: unknown) {} as unknown as {
  new (): {
    init: () => Promise<[number, string, string]>;
  };
};

StatusEndpoint.prototype = {
  supportedMethods: ["GET"],
  permitBookmarklet: false,

  init: async function (): Promise<[number, string, string]> {
    try {
      const body = {
        pending: jobQueue.pendingCount(),
        inFlight: jobQueue.inFlightCount(),
      };
      return [200, "application/json", JSON.stringify(body)];
    } catch (error) {
      log(`GET ${STATUS_PATH} handler threw: ${error}`);
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
  isTopLevelItem(): boolean;
  getAttachments(): number[];
  getField(field: string): string;
  saveTx(): Promise<unknown>;
}

export interface FoundDuplicate {
  item: ZoteroItemLike;
  rule: MatchRule;
}

export interface ApplyResultDeps {
  items: ResultItemLookup;
  getItem(id: number): ZoteroItemLike | null;
  trash(id: number): Promise<unknown>;
  linkedUrlLinkMode: number;
  /** extensions.zotero.batchopen.reconcileSavedItems. Default true. */
  reconcileEnabled: boolean;
  /** extensions.zotero.batchopen.attachmentWaitMs. Default 60000. */
  attachmentWaitMs: number;
  /** How often to re-check for the attachment while waiting. */
  pollIntervalMs: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  /**
   * Fallback duplicate lookup (src/core/duplicateMatch.ts via reconcile.ts's
   * selectCandidates/planReconciliation) used when the connector reported no
   * savedItemKeys, or the keyed item(s) never gained a file attachment
   * within attachmentWaitMs. Scoped to items added at/after windowStartMs.
   */
  findDuplicate(
    original: ZoteroItemLike,
    windowStartMs: number,
  ): FoundDuplicate | null | Promise<FoundDuplicate | null>;
}

export interface ApplyResultOutcome {
  ok: boolean;
  filesMoved: number;
  itemsTrashed: number;
  error?: string;
  /**
   * True when reconciliation is still running in the background (see
   * reconcileInBackground below) -- this response returned before it
   * finished, so filesMoved/itemsTrashed here are not yet final. The
   * eventual outcome is logged, not returned (nothing awaits this).
   */
  pending?: boolean;
}

function moveFileAttachments(
  saved: ZoteroItemLike,
  original: ZoteroItemLike,
  deps: ApplyResultDeps,
): Promise<number> {
  return (async () => {
    let moved = 0;
    for (const attId of saved.getAttachments()) {
      const attachment = deps.getItem(attId);
      if (
        !attachment ||
        !isFileAttachment(attachment, deps.linkedUrlLinkMode)
      ) {
        continue;
      }
      attachment.parentID = original.id;
      await attachment.saveTx();
      moved += 1;
    }
    return moved;
  })();
}

/**
 * The result-handling logic, factored out from the Zotero.Server.Endpoint
 * wrapper so it's unit-testable against fakes.
 *
 * A connector-reported failure fails the job synchronously, as before. A
 * connector-reported success completes the job immediately (the connector's
 * part -- performing the save -- is done) and, only if reconciliation is
 * enabled, kicks off reconcileInBackground() WITHOUT awaiting it: the
 * connector's own POST has a short timeout (see batchOpenQueue.js's
 * _reportResult()) and reconciliation can legitimately take up to
 * attachmentWaitMs (Zotero's own saveAttachment for a newly-saved item
 * finishes visibly after saveItems returns, per the user's connector debug
 * log) waiting for the new item to gain a stored file. Making the connector
 * hold its response open that long would either time out client-side or
 * (worse, on Chrome MV3) rely on an unverified assumption about whether a
 * pending fetch keeps an extension service worker alive -- exactly the kind
 * of assumption that already broke this feature once (see batchOpenQueue.js
 * header). Reconciliation therefore reports its own eventual outcome to the
 * Zotero-side log independently; the browser never needs to see it.
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

  // Connector-side save succeeded. That is this job's own work; mark it done
  // regardless of what reconciliation later finds (a "job" here is "did the
  // connector save the page", not "did we successfully merge it back").
  jobQueue.complete(payload.jobId);

  if (!deps.reconcileEnabled) {
    const keys =
      payload.savedItemKeys && payload.savedItemKeys.length
        ? payload.savedItemKeys.join(", ")
        : "(no keys reported)";
    log(
      `POST ${RESULT_PATH} jobId=${payload.jobId} itemKey=${job.itemKey} ` +
        `OK: saved as new item(s) ${keys}; reconciliation disabled` +
        (payload.detail ? ` (${payload.detail})` : ""),
    );
    return { ok: true, filesMoved: 0, itemsTrashed: 0 };
  }

  log(
    `POST ${RESULT_PATH} jobId=${payload.jobId} itemKey=${job.itemKey} ` +
      `OK: connector save succeeded, reconciling in the background` +
      (payload.detail ? ` (${payload.detail})` : ""),
  );
  reconcileInBackground(payload, job, deps).catch((error) => {
    log(
      `POST ${RESULT_PATH} jobId=${payload.jobId} itemKey=${job.itemKey} reconciliation crashed: ${error}`,
    );
  });

  return { ok: true, filesMoved: 0, itemsTrashed: 0, pending: true };
}

/**
 * Runs after applyResult() has already responded to the connector: waits
 * (up to deps.attachmentWaitMs, polling every deps.pollIntervalMs) for the
 * saved item(s) to gain a stored file attachment, moves it onto the
 * original and trashes the now-emptied saved item, or -- if no keys were
 * reported at all, or the keyed item(s) never gained a file -- falls back
 * to deps.findDuplicate() (the same duplicate-matching the manual "Attach
 * newly saved files" command uses). Never touches the original's existing
 * attachments; only ever trashes (never permanently deletes) the item the
 * file was moved off of. Logs its own outcome; returns nothing (callers of
 * applyResult never await this).
 */
export async function reconcileInBackground(
  payload: ResultPayload,
  job: Job,
  deps: ApplyResultDeps,
): Promise<void> {
  const logPrefix = `POST ${RESULT_PATH} jobId=${payload.jobId} itemKey=${job.itemKey} reconciliation`;

  const original = deps.items.getByLibraryAndKey(job.libraryID, job.itemKey);
  if (!original) {
    log(
      `${logPrefix} FAILED: original item not found for itemKey=${job.itemKey}`,
    );
    return;
  }

  const savedKeys = payload.savedItemKeys || [];
  let readyKeys: string[] = [];

  if (savedKeys.length > 0) {
    const deadline = deps.now() + deps.attachmentWaitMs;
    for (;;) {
      readyKeys = savedKeys.filter((key) => {
        const saved = deps.items.getByLibraryAndKey(job.libraryID, key);
        if (!saved) return false;
        return saved.getAttachments().some((id) => {
          const att = deps.getItem(id);
          return !!att && isFileAttachment(att, deps.linkedUrlLinkMode);
        });
      });
      if (readyKeys.length > 0 || deps.now() >= deadline) break;
      await deps.sleep(deps.pollIntervalMs);
    }
  }

  let filesMoved = 0;
  let itemsTrashed = 0;
  let matchedVia: string | null = null;

  if (readyKeys.length > 0) {
    for (const savedKey of readyKeys) {
      const saved = deps.items.getByLibraryAndKey(job.libraryID, savedKey);
      if (!saved) continue;
      const movedForThis = await moveFileAttachments(saved, original, deps);
      filesMoved += movedForThis;
      if (movedForThis > 0) {
        await deps.trash(saved.id);
        itemsTrashed += 1;
      }
    }
    if (itemsTrashed > 0) matchedVia = "savedItemKeys";
  }

  if (itemsTrashed === 0) {
    // No keys arrived at all, or the keyed item(s) never gained a file
    // within budget -- fall back to duplicate matching (DOI, then
    // PMID/arXiv, then title+year), scoped to items added since this job
    // was handed out.
    const found = await deps.findDuplicate(original, job.enqueuedAtMs);
    if (found) {
      const movedForThis = await moveFileAttachments(
        found.item,
        original,
        deps,
      );
      filesMoved += movedForThis;
      if (movedForThis > 0) {
        await deps.trash(found.item.id);
        itemsTrashed += 1;
        matchedVia = `duplicateMatch:${found.rule}`;
      }
    }
  }

  if (itemsTrashed > 0) {
    log(
      `${logPrefix} OK: filesMoved=${filesMoved} itemsTrashed=${itemsTrashed} (matched via ${matchedVia})`,
    );
    return;
  }

  const reason =
    savedKeys.length > 0
      ? `saved, but no attachment appeared within ${Math.round(deps.attachmentWaitMs / 1000)}s`
      : `saved, but no matching item found`;
  log(`${logPrefix} FAILED: ${reason}`);
}

function readReconcileEnabledPref(): boolean {
  try {
    const value = Zotero.Prefs.get(
      "extensions.zotero.batchopen.reconcileSavedItems",
      true,
    );
    return value === undefined || value === null ? true : !!value;
  } catch {
    return true;
  }
}

function readAttachmentWaitMsPref(): number {
  try {
    const value = Zotero.Prefs.get(
      "extensions.zotero.batchopen.attachmentWaitMs",
      60000,
    );
    return typeof value === "number" && value > 0 ? value : 60000;
  } catch {
    return 60000;
  }
}

async function liveFindDuplicate(
  original: ZoteroItemLike,
  windowStartMs: number,
): Promise<FoundDuplicate | null> {
  try {
    // Real Zotero.Items.getAll(libraryID, onlyTopLevel?, includeDeleted?,
    // asIDs?) is async and requires a libraryID -- see
    // node_modules/zotero-types/types/xpcom/data/items.d.ts. Calling it with
    // no args (as this used to) returns a Promise, not an array, which made
    // the .filter() below throw "allItems.filter is not a function".
    const ZoteroItems = Zotero.Items as unknown as {
      getAll(libraryID: number): ZoteroItemLike[] | Promise<ZoteroItemLike[]>;
    };
    const allItems = await resolveAllItems(() =>
      ZoteroItems.getAll(original.libraryID),
    );
    const candidates = selectCandidates(allItems, {
      excludeIds: new Set([original.id]),
      libraryIDs: new Set([original.libraryID]),
      isTopLevelRegular: (item) => {
        try {
          return item.isRegularItem() && item.isTopLevelItem();
        } catch {
          return false;
        }
      },
      dateAddedMs: (item) => {
        try {
          return parseZoteroDateAddedMs(item.getField("dateAdded"));
        } catch {
          return null;
        }
      },
      windowStartMs,
    });
    const plan = planReconciliation([original], candidates);
    if (plan.length === 0) return null;
    return { item: plan[0].duplicate, rule: plan[0].match.rule };
  } catch (error) {
    log(`findDuplicate failed: ${error}`);
    return null;
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
    reconcileEnabled: readReconcileEnabledPref(),
    attachmentWaitMs: readAttachmentWaitMsPref(),
    pollIntervalMs: 2000,
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    findDuplicate: liveFindDuplicate,
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

/** Injectable so tests don't hit the network; defaults to the real resolver. */
export type RedirectResolverFn = (
  url: string,
) => Promise<{ finalUrl: string; hops: number; resolved: boolean }>;

/**
 * For each selected regular item with no stored PDF, resolve a URL using
 * the same order as "Open all in browser" (stored url -> DOI -> first
 * attachment url; no search fallback — there is nothing useful to save from
 * a search results page) and enqueue it. Returns counts for the on-screen
 * summary.
 *
 * When the resolved URL's host is a known redirector (doi.org,
 * linkinghub.elsevier.com, ...; see redirectResolver.ts), follows it from
 * Zotero's own process before enqueueing, so the browser tab this job opens
 * lands directly on the article page rather than having to chase the chain
 * itself. Resolution failure (network error, timeout, no known host) falls
 * back to enqueueing the URL as originally chosen — a job is never dropped
 * because resolution failed.
 *
 * Deduplicates on (libraryID, itemKey): an item that already has a pending
 * or in-flight job is skipped rather than enqueued again, so re-running
 * this command on the same selection (e.g. because the connector poller
 * had not yet started) does not pile up duplicate jobs for the same item.
 */
export async function enqueueSelectedItems(
  selected: EnqueueSelectableItem[],
  itemLookup: EnqueueItemLookup,
  linkedUrlLinkMode: number,
  resolveRedirector: RedirectResolverFn = resolveRedirectorUrl,
): Promise<EnqueueResult> {
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

    let finalUrl = resolved.url;
    if (isKnownRedirectorUrl(resolved.url)) {
      try {
        const resolution = await resolveRedirector(resolved.url);
        if (resolution.resolved) {
          finalUrl = resolution.finalUrl;
          log(
            `enqueue: resolved redirector ${resolved.url} -> ${finalUrl} ` +
              `(${resolution.hops} hop(s)) for itemKey=${item.key}`,
          );
        }
      } catch (error) {
        // resolveRedirectorUrl itself never throws, but a caller-supplied
        // (e.g. test) resolver might -- never drop the job over it.
        log(
          `enqueue: redirector resolution threw for ${resolved.url} ` +
            `(itemKey=${item.key}): ${error}; enqueueing unresolved`,
        );
      }
    }

    jobQueue.enqueue({
      url: finalUrl,
      originalUrl: resolved.url,
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
