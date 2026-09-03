import { beforeEach, describe, expect, it } from "vitest";
import {
  registerEndpointsOnRegistry,
  applyResult,
  reconcileInBackground,
  enqueueSelectedItems,
  clearConnectorQueue,
  extractMaxParam,
  extractQueryParam,
  checkConfirm,
  jobQueue,
  QueueEndpoint,
  ResultEndpoint,
  StatusEndpoint,
  ConfirmEndpoint,
  type ApplyResultDeps,
  type ConfirmDeps,
  type ZoteroItemLike,
  type EnqueueSelectableItem,
} from "@/services/queueServer";

/** Deps with every field pre-filled for tests that only care about a few. */
function baseDeps(overrides: Partial<ApplyResultDeps> = {}): ApplyResultDeps {
  return {
    items: { getByLibraryAndKey: () => false },
    getItem: () => null,
    trash: async () => {},
    linkedUrlLinkMode: 3,
    reconcileEnabled: true,
    attachmentWaitMs: 1000,
    pollIntervalMs: 1,
    now: () => Date.now(),
    sleep: async () => {},
    findDuplicate: () => null,
    ...overrides,
  };
}

describe("registerEndpointsOnRegistry", () => {
  it("registers both endpoints on a plain object registry", () => {
    const registry: Record<string, unknown> = {};
    const result = registerEndpointsOnRegistry(registry);
    expect(result.registered).toBe(true);
    expect(registry["/batchopen/queue"]).toBe(QueueEndpoint);
    expect(registry["/batchopen/result"]).toBe(ResultEndpoint);
    expect(registry["/batchopen/status"]).toBe(StatusEndpoint);
    expect(registry["/batchopen/confirm"]).toBe(ConfirmEndpoint);
  });

  it("reports failure when the registry is undefined", () => {
    const result = registerEndpointsOnRegistry(undefined);
    expect(result.registered).toBe(false);
    expect(result.reason).toMatch(/not available/);
  });

  it("reports failure when the registry is null", () => {
    const result = registerEndpointsOnRegistry(null);
    expect(result.registered).toBe(false);
  });

  it("reports failure when assignment does not stick (frozen registry)", () => {
    const registry = Object.freeze({}) as Record<string, unknown>;
    const result = registerEndpointsOnRegistry(registry);
    expect(result.registered).toBe(false);
  });

  it("reports failure when something else already owns the path", () => {
    const registry: Record<string, unknown> = {};
    // Use a getter that always returns a foreign value, simulating another
    // plugin's endpoint silently owning the same path.
    Object.defineProperty(registry, "/batchopen/queue", {
      get: () => "someone-elses-endpoint",
      set: () => {
        /* swallow the write */
      },
      configurable: true,
    });
    const result = registerEndpointsOnRegistry(registry);
    expect(result.registered).toBe(false);
    expect(result.reason).toMatch(/read-back mismatch/);
  });
});

function makeAttachment(
  id: number,
  overrides: Partial<ZoteroItemLike> = {},
): ZoteroItemLike {
  return {
    id,
    key: `ATT${id}`,
    libraryID: 1,
    parentID: undefined,
    attachmentContentType: "application/pdf",
    attachmentLinkMode: 0, // imported file (not linkedUrlLinkMode=3)
    isRegularItem: () => false,
    isTopLevelItem: () => false,
    getAttachments: () => [],
    getField: () => "",
    saveTx: async () => {},
    ...overrides,
  };
}

function makeItem(
  id: number,
  key: string,
  attachmentIds: number[],
  overrides: Partial<ZoteroItemLike> = {},
): ZoteroItemLike {
  return {
    id,
    key,
    libraryID: 1,
    isRegularItem: () => true,
    isTopLevelItem: () => true,
    getAttachments: () => attachmentIds,
    getField: () => "",
    saveTx: async () => {},
    ...overrides,
  };
}

describe("applyResult", () => {
  beforeEach(() => {
    // jobQueue is a module singleton; clear it between tests so leftover
    // pending/in-flight jobs from one test don't affect dedupe checks in
    // another.
    jobQueue.clear();
  });

  it("returns ok:false for an unknown jobId", async () => {
    const outcome = await applyResult(
      { jobId: "does-not-exist", ok: true, savedItemKeys: [] },
      baseDeps(),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/unknown jobId/);
  });

  it("marks the job failed and returns ok:false when the connector reports failure", async () => {
    const jobId = jobQueue.enqueue({
      url: "https://x",
      itemKey: "ORIG1",
      libraryID: 1,
    });
    jobQueue.takeBatch(10);
    const outcome = await applyResult(
      { jobId, ok: false, error: "translator not found" },
      baseDeps(),
    );
    expect(outcome.ok).toBe(false);
    expect(jobQueue.get(jobId)?.status).toBe("failed");
  });

  it("completes the job immediately on a connector-reported success, before reconciliation finishes", async () => {
    const jobId = jobQueue.enqueue({
      url: "https://x",
      itemKey: "ORIG1",
      libraryID: 1,
    });
    jobQueue.takeBatch(10);
    const outcome = await applyResult(
      { jobId, ok: true, savedItemKeys: ["SAVED1"] },
      baseDeps({ findDuplicate: () => null }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.pending).toBe(true);
    expect(jobQueue.get(jobId)?.status).toBe("done");
  });

  it("does nothing but log when reconciliation is disabled", async () => {
    const jobId = jobQueue.enqueue({
      url: "https://x",
      itemKey: "ORIG1",
      libraryID: 1,
    });
    jobQueue.takeBatch(10);
    let trashCalled = false;
    const outcome = await applyResult(
      { jobId, ok: true, savedItemKeys: ["SAVED1"] },
      baseDeps({
        reconcileEnabled: false,
        trash: async () => {
          trashCalled = true;
        },
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.filesMoved).toBe(0);
    expect(outcome.pending).toBeUndefined();
    expect(trashCalled).toBe(false);
    expect(jobQueue.get(jobId)?.status).toBe("done");
  });
});

describe("reconcileInBackground", () => {
  beforeEach(() => {
    jobQueue.clear();
  });

  it("moves stored file attachments from the saved item onto the original, then trashes the saved item", async () => {
    const jobId = jobQueue.enqueue({
      url: "https://x",
      itemKey: "ORIG1",
      libraryID: 1,
    });
    jobQueue.takeBatch(10);
    const job = jobQueue.get(jobId)!;

    const original = makeItem(100, "ORIG1", []);
    const pdfAttachment = makeAttachment(201);
    const linkAttachment = makeAttachment(202, {
      attachmentLinkMode: 3, // linked URL — must NOT move
      attachmentContentType: "text/html",
    });
    const saved = makeItem(200, "SAVED1", [201, 202]);

    const itemsById = new Map<number, ZoteroItemLike>([
      [100, original],
      [200, saved],
      [201, pdfAttachment],
      [202, linkAttachment],
    ]);
    const itemsByKey = new Map<string, ZoteroItemLike>([
      ["ORIG1", original],
      ["SAVED1", saved],
    ]);

    const trashedIds: number[] = [];
    const deps = baseDeps({
      items: {
        getByLibraryAndKey: (_lib, key) => itemsByKey.get(key) || false,
      },
      getItem: (id) => itemsById.get(id) || null,
      trash: async (id) => {
        trashedIds.push(id);
      },
    });

    await reconcileInBackground(
      { jobId, ok: true, savedItemKeys: ["SAVED1"] },
      job,
      deps,
    );

    expect(pdfAttachment.parentID).toBe(100);
    expect(linkAttachment.parentID).toBeUndefined();
    expect(trashedIds).toEqual([200]);
  });

  it("waits (polling) for the attachment to appear before moving it", async () => {
    const jobId = jobQueue.enqueue({
      url: "https://x",
      itemKey: "ORIG1",
      libraryID: 1,
    });
    jobQueue.takeBatch(10);
    const job = jobQueue.get(jobId)!;

    const original = makeItem(100, "ORIG1", []);
    const saved = makeItem(200, "SAVED1", []); // no attachments yet
    let pollCount = 0;
    const trashedIds: number[] = [];

    const deps = baseDeps({
      items: {
        getByLibraryAndKey: (_lib, key) => {
          if (key === "ORIG1") return original;
          if (key === "SAVED1") return saved;
          return false;
        },
      },
      getItem: (id) => (id === 201 ? makeAttachment(201) : null),
      trash: async (id) => {
        trashedIds.push(id);
      },
      pollIntervalMs: 1,
      attachmentWaitMs: 1000,
      sleep: async () => {
        pollCount += 1;
        if (pollCount === 2) {
          // The attachment "appears" after the second poll tick.
          saved.getAttachments = () => [201];
        }
      },
    });

    await reconcileInBackground(
      { jobId, ok: true, savedItemKeys: ["SAVED1"] },
      job,
      deps,
    );

    expect(trashedIds).toEqual([200]);
    expect(pollCount).toBeGreaterThanOrEqual(2);
  });

  it("falls back to duplicate matching when no keys are reported", async () => {
    const jobId = jobQueue.enqueue({
      url: "https://x",
      itemKey: "ORIG1",
      libraryID: 1,
    });
    jobQueue.takeBatch(10);
    const job = jobQueue.get(jobId)!;

    const original = makeItem(100, "ORIG1", []);
    const dupAttachment = makeAttachment(301);
    const duplicate = makeItem(300, "DUP1", [301]);
    const trashedIds: number[] = [];

    const deps = baseDeps({
      items: {
        getByLibraryAndKey: (_lib, key) => (key === "ORIG1" ? original : false),
      },
      getItem: (id) => (id === 301 ? dupAttachment : null),
      trash: async (id) => {
        trashedIds.push(id);
      },
      findDuplicate: (orig) => {
        expect(orig).toBe(original);
        return { item: duplicate, rule: "doi" };
      },
    });

    await reconcileInBackground(
      { jobId, ok: true, savedItemKeys: [] },
      job,
      deps,
    );

    expect(dupAttachment.parentID).toBe(100);
    expect(trashedIds).toEqual([300]);
  });

  it("falls back to duplicate matching when the keyed item never gains a file within budget", async () => {
    const jobId = jobQueue.enqueue({
      url: "https://x",
      itemKey: "ORIG1",
      libraryID: 1,
    });
    jobQueue.takeBatch(10);
    const job = jobQueue.get(jobId)!;

    const original = makeItem(100, "ORIG1", []);
    const saved = makeItem(200, "SAVED1", []); // never gains an attachment
    const dupAttachment = makeAttachment(301);
    const duplicate = makeItem(300, "DUP1", [301]);
    const trashedIds: number[] = [];
    let now = 0;

    const deps = baseDeps({
      items: {
        getByLibraryAndKey: (_lib, key) => {
          if (key === "ORIG1") return original;
          if (key === "SAVED1") return saved;
          return false;
        },
      },
      getItem: (id) => (id === 301 ? dupAttachment : null),
      trash: async (id) => {
        trashedIds.push(id);
      },
      attachmentWaitMs: 10,
      pollIntervalMs: 5,
      now: () => now,
      sleep: async () => {
        now += 5;
      },
      findDuplicate: () => ({ item: duplicate, rule: "title-year" }),
    });

    await reconcileInBackground(
      { jobId, ok: true, savedItemKeys: ["SAVED1"] },
      job,
      deps,
    );

    expect(trashedIds).toEqual([300]);
  });

  it("logs a specific failure (never throws) when the original item cannot be found", async () => {
    const jobId = jobQueue.enqueue({
      url: "https://x",
      itemKey: "GONE",
      libraryID: 1,
    });
    jobQueue.takeBatch(10);
    const job = jobQueue.get(jobId)!;

    await expect(
      reconcileInBackground(
        { jobId, ok: true, savedItemKeys: ["X"] },
        job,
        baseDeps(),
      ),
    ).resolves.toBeUndefined();
  });

  it("does not move anything when neither keys nor duplicate matching find a target", async () => {
    const jobId = jobQueue.enqueue({
      url: "https://x",
      itemKey: "ORIG1",
      libraryID: 1,
    });
    jobQueue.takeBatch(10);
    const job = jobQueue.get(jobId)!;
    const original = makeItem(100, "ORIG1", []);
    let trashCalled = false;

    await reconcileInBackground(
      { jobId, ok: true, savedItemKeys: [] },
      job,
      baseDeps({
        items: {
          getByLibraryAndKey: (_lib, key) =>
            key === "ORIG1" ? original : false,
        },
        trash: async () => {
          trashCalled = true;
        },
        findDuplicate: () => null,
      }),
    );

    expect(trashCalled).toBe(false);
  });
});

describe("enqueueSelectedItems", () => {
  beforeEach(() => {
    jobQueue.clear();
  });

  function selectable(
    key: string,
    overrides: Partial<EnqueueSelectableItem> = {},
  ): EnqueueSelectableItem {
    return {
      isRegularItem: () => true,
      key,
      libraryID: 1,
      getField: () => "",
      getAttachments: () => [],
      ...overrides,
    };
  }

  it("enqueues items missing a stored PDF that resolve to a URL", async () => {
    const item = selectable("K1", {
      getField: (f) => (f === "url" ? "https://example.com/paper" : ""),
    });
    const result = await enqueueSelectedItems([item], { get: () => null }, 3);
    expect(result.enqueued).toBe(1);
    expect(result.skippedHasPdf).toBe(0);
    expect(result.skippedNoUrl).toBe(0);
    expect(jobQueue.get(jobQueue.takeBatch(1)[0].jobId)?.url).toBe(
      "https://example.com/paper",
    );
  });

  it("skips items that already have a stored PDF", async () => {
    const pdf: EnqueueSelectableItem = {
      isRegularItem: () => false,
      key: "ATT1",
      libraryID: 1,
      getField: () => "",
      getAttachments: () => [],
      attachmentContentType: "application/pdf",
      attachmentLinkMode: 0,
    };
    const item = selectable("K1", { getAttachments: () => [1] });
    const result = await enqueueSelectedItems([item], { get: () => pdf }, 3);
    expect(result.enqueued).toBe(0);
    expect(result.skippedHasPdf).toBe(1);
  });

  it("skips items with no url, DOI, or attachment url", async () => {
    const item = selectable("K1");
    const result = await enqueueSelectedItems([item], { get: () => null }, 3);
    expect(result.enqueued).toBe(0);
    expect(result.skippedNoUrl).toBe(1);
  });

  it("counts non-regular items in the selection as skippedNotRegular", async () => {
    const note: EnqueueSelectableItem = {
      isRegularItem: () => false,
      key: "N1",
      libraryID: 1,
      getField: () => "",
      getAttachments: () => [],
    };
    const result = await enqueueSelectedItems([note], { get: () => null }, 3);
    expect(result.skippedNotRegular).toBe(1);
    expect(result.enqueued).toBe(0);
  });

  it("resolves from DOI when no stored url is present", async () => {
    const item = selectable("K1", {
      getField: (f) => (f === "DOI" ? "10.1000/xyz" : ""),
    });
    const result = await enqueueSelectedItems([item], { get: () => null }, 3);
    expect(result.enqueued).toBe(1);
  });

  it("resolves a known redirector URL at enqueue time and keeps the original for logging", async () => {
    const item = selectable("K1", {
      getField: (f) => (f === "DOI" ? "10.1000/xyz" : ""),
    });
    const resolver = async (url: string) => ({
      finalUrl: "https://publisher.example.com/article/1",
      hops: 2,
      resolved: true,
    });
    await enqueueSelectedItems([item], { get: () => null }, 3, resolver);
    const [job] = jobQueue.takeBatch(1);
    expect(job.url).toBe("https://publisher.example.com/article/1");
    expect(jobQueue.get(job.jobId)?.originalUrl).toBe(
      "https://doi.org/10.1000/xyz",
    );
  });

  it("falls back to the unresolved URL when the redirector resolver fails to resolve", async () => {
    const item = selectable("K1", {
      getField: (f) => (f === "DOI" ? "10.1000/xyz" : ""),
    });
    const resolver = async (url: string) => ({
      finalUrl: url,
      hops: 0,
      resolved: false,
    });
    await enqueueSelectedItems([item], { get: () => null }, 3, resolver);
    const [job] = jobQueue.takeBatch(1);
    expect(job.url).toBe("https://doi.org/10.1000/xyz");
    expect(jobQueue.get(job.jobId)?.originalUrl).toBeUndefined();
  });

  it("does not attempt redirector resolution for an already-final stored URL", async () => {
    const item = selectable("K1", {
      getField: (f) => (f === "url" ? "https://example.com/paper" : ""),
    });
    let resolverCalled = false;
    const resolver = async (url: string) => {
      resolverCalled = true;
      return { finalUrl: url, hops: 0, resolved: false };
    };
    await enqueueSelectedItems([item], { get: () => null }, 3, resolver);
    expect(resolverCalled).toBe(false);
  });

  it("skips an item that already has a pending job for the same key, and reports it", async () => {
    const item = selectable("K1", {
      getField: (f) => (f === "url" ? "https://example.com/paper" : ""),
    });
    const first = await enqueueSelectedItems([item], { get: () => null }, 3);
    expect(first.enqueued).toBe(1);
    expect(first.skippedAlreadyQueued).toBe(0);

    const second = await enqueueSelectedItems([item], { get: () => null }, 3);
    expect(second.enqueued).toBe(0);
    expect(second.skippedAlreadyQueued).toBe(1);
    expect(jobQueue.pendingCount()).toBe(1);
  });

  it("skips an item with an in-flight job for the same key", async () => {
    const item = selectable("K1", {
      getField: (f) => (f === "url" ? "https://example.com/paper" : ""),
    });
    await enqueueSelectedItems([item], { get: () => null }, 3);
    jobQueue.takeBatch(10); // move the job from pending to in-flight

    const result = await enqueueSelectedItems([item], { get: () => null }, 3);
    expect(result.enqueued).toBe(0);
    expect(result.skippedAlreadyQueued).toBe(1);
  });

  it("allows re-enqueuing an item once its prior job is done or failed", async () => {
    const item = selectable("K1", {
      getField: (f) => (f === "url" ? "https://example.com/paper" : ""),
    });
    await enqueueSelectedItems([item], { get: () => null }, 3);
    const [job] = jobQueue.takeBatch(10);
    jobQueue.complete(job.jobId);

    const result = await enqueueSelectedItems([item], { get: () => null }, 3);
    expect(result.enqueued).toBe(1);
    expect(result.skippedAlreadyQueued).toBe(0);
  });
});

describe("extractMaxParam", () => {
  it("returns undefined when options.query is absent", () => {
    expect(extractMaxParam({})).toBeUndefined();
  });

  it("returns undefined when options.query is null", () => {
    expect(
      extractMaxParam({ query: null as unknown as undefined }),
    ).toBeUndefined();
  });

  it("reads max from the documented/actual Record<string,string> shape", () => {
    expect(extractMaxParam({ query: { max: "1" } })).toBe("1");
  });

  it("returns undefined from a Record shape with no max key", () => {
    expect(extractMaxParam({ query: { other: "1" } })).toBeUndefined();
  });

  it("reads max from a raw query string", () => {
    expect(extractMaxParam({ query: "max=5" })).toBe("5");
  });

  it("reads max from a raw query string with a leading '?'", () => {
    expect(extractMaxParam({ query: "?max=5" })).toBe("5");
  });

  it("reads max from a raw query string with other params present", () => {
    expect(extractMaxParam({ query: "foo=bar&max=3&baz=1" })).toBe("3");
  });

  it("returns undefined from a raw query string with no max param", () => {
    expect(extractMaxParam({ query: "foo=bar" })).toBeUndefined();
  });

  it("reads max from a URLSearchParams-like object", () => {
    expect(extractMaxParam({ query: new URLSearchParams("max=7") })).toBe("7");
  });

  it("returns undefined from a URLSearchParams-like object with no max param", () => {
    expect(
      extractMaxParam({ query: new URLSearchParams("foo=bar") }),
    ).toBeUndefined();
  });

  it("reads max from a Record keyed with a leading '?max'", () => {
    expect(extractMaxParam({ query: { "?max": "2" } })).toBe("2");
  });

  it("prefers an unprefixed 'max' key over '?max' when both are present", () => {
    expect(extractMaxParam({ query: { max: "1", "?max": "2" } })).toBe("1");
  });

  it("takes the first value when max arrived as an array (repeated query param)", () => {
    expect(
      extractMaxParam({ query: { max: ["4", "9"] as unknown as string } }),
    ).toBe("4");
  });
});

describe("QueueEndpoint", () => {
  beforeEach(() => {
    jobQueue.clear();
  });

  it("hands out up to DEFAULT_BATCH_SIZE jobs when no ?max is given", async () => {
    for (let i = 0; i < 3; i++) {
      jobQueue.enqueue({
        url: `https://x/${i}`,
        itemKey: `K${i}`,
        libraryID: 1,
      });
    }
    const endpoint = new QueueEndpoint();
    const [status, , body] = await endpoint.init({});
    expect(status).toBe(200);
    expect(JSON.parse(body).jobs).toHaveLength(3);
  });

  it("caps the batch at ?max= when the connector asks for fewer jobs at a time", async () => {
    for (let i = 0; i < 3; i++) {
      jobQueue.enqueue({
        url: `https://x/${i}`,
        itemKey: `K${i}`,
        libraryID: 1,
      });
    }
    const endpoint = new QueueEndpoint();
    const [status, , body] = await endpoint.init({ query: { max: "1" } });
    expect(status).toBe(200);
    expect(JSON.parse(body).jobs).toHaveLength(1);
    expect(jobQueue.pendingCount()).toBe(2);
  });

  it("ignores a nonsensical ?max= and falls back to the default batch size", async () => {
    jobQueue.enqueue({ url: "https://x", itemKey: "K", libraryID: 1 });
    const endpoint = new QueueEndpoint();
    const [status, , body] = await endpoint.init({
      query: { max: "not-a-number" },
    });
    expect(status).toBe(200);
    expect(JSON.parse(body).jobs).toHaveLength(1);
  });

  it("caps the batch at ?max= given as a raw query string instead of a Record", async () => {
    jobQueue.enqueue({ url: "https://x/0", itemKey: "K0", libraryID: 1 });
    jobQueue.enqueue({ url: "https://x/1", itemKey: "K1", libraryID: 1 });
    const endpoint = new QueueEndpoint();
    const [status, , body] = await endpoint.init({
      query: "max=1" as unknown as Record<string, string>,
    });
    expect(status).toBe(200);
    expect(JSON.parse(body).jobs).toHaveLength(1);
    expect(jobQueue.pendingCount()).toBe(1);
  });

  it("does not hand out a job that is already in-flight (claimed by an earlier poll)", async () => {
    jobQueue.enqueue({ url: "https://x", itemKey: "K", libraryID: 1 });
    // Simulate an earlier, unlimited poll having already claimed the only
    // job -- this is the scenario the live-Zotero diagnostic actually hit:
    // a bare GET /batchopen/queue claimed the one queued job before a
    // follow-up GET /batchopen/queue?max=1 was made, so the second request
    // correctly sees nothing pending. That is not a parsing bug.
    jobQueue.takeBatch(10);
    const endpoint = new QueueEndpoint();
    const [status, , body] = await endpoint.init({ query: { max: "1" } });
    expect(status).toBe(200);
    expect(JSON.parse(body).jobs).toHaveLength(0);
  });
});

describe("StatusEndpoint", () => {
  beforeEach(() => {
    jobQueue.clear();
  });

  it("reports pending/in-flight counts without claiming any job", async () => {
    jobQueue.enqueue({ url: "https://a", itemKey: "A", libraryID: 1 });
    jobQueue.enqueue({ url: "https://b", itemKey: "B", libraryID: 1 });
    jobQueue.takeBatch(1); // one in-flight, one still pending

    const endpoint = new StatusEndpoint();
    const [status, , body] = await endpoint.init();
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ pending: 1, inFlight: 1 });
    // Still there -- nothing was claimed by the status check itself.
    expect(jobQueue.pendingCount()).toBe(1);
    expect(jobQueue.inFlightCount()).toBe(1);
  });
});

function baseConfirmDeps(overrides: Partial<ConfirmDeps> = {}): ConfirmDeps {
  return {
    items: { getByLibraryAndKey: () => false },
    findDuplicate: () => null,
    ...overrides,
  };
}

describe("checkConfirm", () => {
  beforeEach(() => {
    jobQueue.clear();
  });

  it("reports not found (with a reason) for an unknown jobId", async () => {
    const outcome = await checkConfirm("does-not-exist", baseConfirmDeps());
    expect(outcome.found).toBe(false);
    expect(outcome.reason).toMatch(/unknown jobId/);
  });

  it("reports not found (with a reason) when jobId is missing", async () => {
    const outcome = await checkConfirm(undefined, baseConfirmDeps());
    expect(outcome.found).toBe(false);
    expect(outcome.reason).toMatch(/missing jobId/);
  });

  it("reports not found when the original item no longer exists", async () => {
    const jobId = jobQueue.enqueue({
      url: "https://x",
      itemKey: "ORIG1",
      libraryID: 1,
    });
    const outcome = await checkConfirm(jobId, baseConfirmDeps());
    expect(outcome.found).toBe(false);
    expect(outcome.reason).toMatch(/original item not found/);
  });

  it("reports found with the matched item's key when findDuplicate matches", async () => {
    const jobId = jobQueue.enqueue({
      url: "https://x",
      itemKey: "ORIG1",
      libraryID: 1,
    });
    const original = makeItem(1, "ORIG1", []);
    const duplicate = makeItem(2, "SAVED1", []);
    const outcome = await checkConfirm(
      jobId,
      baseConfirmDeps({
        items: {
          getByLibraryAndKey: (libraryID, key) =>
            libraryID === 1 && key === "ORIG1" ? original : false,
        },
        findDuplicate: (passedOriginal, windowStartMs) => {
          expect(passedOriginal).toBe(original);
          expect(windowStartMs).toBe(jobQueue.get(jobId)?.enqueuedAtMs);
          return { item: duplicate, rule: "doi" };
        },
      }),
    );
    expect(outcome.found).toBe(true);
    expect(outcome.itemKey).toBe("SAVED1");
  });

  it("reports not found when no duplicate is matched", async () => {
    const jobId = jobQueue.enqueue({
      url: "https://x",
      itemKey: "ORIG1",
      libraryID: 1,
    });
    const original = makeItem(1, "ORIG1", []);
    const outcome = await checkConfirm(
      jobId,
      baseConfirmDeps({
        items: { getByLibraryAndKey: () => original },
        findDuplicate: () => null,
      }),
    );
    expect(outcome.found).toBe(false);
    expect(outcome.itemKey).toBeUndefined();
  });
});

describe("extractQueryParam", () => {
  it("reads a value out of a plain object", () => {
    expect(extractQueryParam({ jobId: "job_1" }, "jobId")).toBe("job_1");
  });

  it("reads a value out of a raw query string, with or without a leading '?'", () => {
    expect(extractQueryParam("jobId=job_1", "jobId")).toBe("job_1");
    expect(extractQueryParam("?jobId=job_1", "jobId")).toBe("job_1");
  });

  it("returns undefined when the key is absent", () => {
    expect(extractQueryParam({}, "jobId")).toBeUndefined();
    expect(extractQueryParam(undefined, "jobId")).toBeUndefined();
  });
});

describe("ConfirmEndpoint", () => {
  beforeEach(() => {
    jobQueue.clear();
  });

  it("returns found:false for a missing jobId query param", async () => {
    const endpoint = new ConfirmEndpoint();
    const [status, , body] = await endpoint.init({ query: {} });
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ found: false, reason: "missing jobId" });
  });

  it("returns found:false with a reason for an unknown jobId", async () => {
    const endpoint = new ConfirmEndpoint();
    const [status, , body] = await endpoint.init({
      query: { jobId: "does-not-exist" },
    });
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.found).toBe(false);
    expect(parsed.reason).toMatch(/unknown jobId/);
  });
});

describe("clearConnectorQueue", () => {
  beforeEach(() => {
    jobQueue.clear();
  });

  it("removes pending and in-flight jobs and reports counts", () => {
    jobQueue.enqueue({ url: "https://a", itemKey: "A", libraryID: 1 });
    jobQueue.enqueue({ url: "https://b", itemKey: "B", libraryID: 1 });
    jobQueue.takeBatch(1); // one job in-flight, one still pending

    const result = clearConnectorQueue();
    expect(result.pendingCleared).toBe(1);
    expect(result.inFlightCleared).toBe(1);
    expect(result.totalCleared).toBe(2);
    expect(jobQueue.pendingCount()).toBe(0);
    expect(jobQueue.inFlightCount()).toBe(0);
  });

  it("is a no-op when the queue is already empty", () => {
    const result = clearConnectorQueue();
    expect(result.totalCleared).toBe(0);
  });
});
