import { beforeEach, describe, expect, it } from "vitest";
import {
  registerEndpointsOnRegistry,
  applyResult,
  enqueueSelectedItems,
  clearConnectorQueue,
  jobQueue,
  QueueEndpoint,
  ResultEndpoint,
  type ApplyResultDeps,
  type ZoteroItemLike,
  type EnqueueSelectableItem,
} from "@/services/queueServer";

describe("registerEndpointsOnRegistry", () => {
  it("registers both endpoints on a plain object registry", () => {
    const registry: Record<string, unknown> = {};
    const result = registerEndpointsOnRegistry(registry);
    expect(result.registered).toBe(true);
    expect(registry["/batchopen/queue"]).toBe(QueueEndpoint);
    expect(registry["/batchopen/result"]).toBe(ResultEndpoint);
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
    getAttachments: () => [],
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
    getAttachments: () => attachmentIds,
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
    const deps: ApplyResultDeps = {
      items: { getByLibraryAndKey: () => false },
      getItem: () => null,
      trash: async () => {},
      linkedUrlLinkMode: 3,
    };
    const outcome = await applyResult(
      { jobId: "does-not-exist", ok: true, savedItemKeys: [] },
      deps,
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
    const deps: ApplyResultDeps = {
      items: { getByLibraryAndKey: () => false },
      getItem: () => null,
      trash: async () => {},
      linkedUrlLinkMode: 3,
    };
    const outcome = await applyResult(
      { jobId, ok: false, error: "translator not found" },
      deps,
    );
    expect(outcome.ok).toBe(false);
    expect(jobQueue.get(jobId)?.status).toBe("failed");
  });

  it("moves stored file attachments from the saved item onto the original, then trashes the saved item", async () => {
    const jobId = jobQueue.enqueue({
      url: "https://x",
      itemKey: "ORIG1",
      libraryID: 1,
    });
    jobQueue.takeBatch(10);

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
    const deps: ApplyResultDeps = {
      items: {
        getByLibraryAndKey: (_lib, key) => itemsByKey.get(key) || false,
      },
      getItem: (id) => itemsById.get(id) || null,
      trash: async (id) => {
        trashedIds.push(id);
      },
      linkedUrlLinkMode: 3,
    };

    const outcome = await applyResult(
      { jobId, ok: true, savedItemKeys: ["SAVED1"] },
      deps,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.filesMoved).toBe(1);
    expect(outcome.itemsTrashed).toBe(1);
    expect(pdfAttachment.parentID).toBe(100);
    expect(linkAttachment.parentID).toBeUndefined();
    expect(trashedIds).toEqual([200]);
    expect(jobQueue.get(jobId)?.status).toBe("done");
  });

  it("fails gracefully (never throws) when the original item cannot be found", async () => {
    const jobId = jobQueue.enqueue({
      url: "https://x",
      itemKey: "GONE",
      libraryID: 1,
    });
    jobQueue.takeBatch(10);
    const deps: ApplyResultDeps = {
      items: { getByLibraryAndKey: () => false },
      getItem: () => null,
      trash: async () => {},
      linkedUrlLinkMode: 3,
    };
    const outcome = await applyResult(
      { jobId, ok: true, savedItemKeys: ["X"] },
      deps,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/original item not found/);
    expect(jobQueue.get(jobId)?.status).toBe("failed");
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

  it("enqueues items missing a stored PDF that resolve to a URL", () => {
    const item = selectable("K1", {
      getField: (f) => (f === "url" ? "https://example.com/paper" : ""),
    });
    const result = enqueueSelectedItems([item], { get: () => null }, 3);
    expect(result.enqueued).toBe(1);
    expect(result.skippedHasPdf).toBe(0);
    expect(result.skippedNoUrl).toBe(0);
  });

  it("skips items that already have a stored PDF", () => {
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
    const result = enqueueSelectedItems([item], { get: () => pdf }, 3);
    expect(result.enqueued).toBe(0);
    expect(result.skippedHasPdf).toBe(1);
  });

  it("skips items with no url, DOI, or attachment url", () => {
    const item = selectable("K1");
    const result = enqueueSelectedItems([item], { get: () => null }, 3);
    expect(result.enqueued).toBe(0);
    expect(result.skippedNoUrl).toBe(1);
  });

  it("counts non-regular items in the selection as skippedNotRegular", () => {
    const note: EnqueueSelectableItem = {
      isRegularItem: () => false,
      key: "N1",
      libraryID: 1,
      getField: () => "",
      getAttachments: () => [],
    };
    const result = enqueueSelectedItems([note], { get: () => null }, 3);
    expect(result.skippedNotRegular).toBe(1);
    expect(result.enqueued).toBe(0);
  });

  it("resolves from DOI when no stored url is present", () => {
    const item = selectable("K1", {
      getField: (f) => (f === "DOI" ? "10.1000/xyz" : ""),
    });
    const result = enqueueSelectedItems([item], { get: () => null }, 3);
    expect(result.enqueued).toBe(1);
  });

  it("skips an item that already has a pending job for the same key, and reports it", () => {
    const item = selectable("K1", {
      getField: (f) => (f === "url" ? "https://example.com/paper" : ""),
    });
    const first = enqueueSelectedItems([item], { get: () => null }, 3);
    expect(first.enqueued).toBe(1);
    expect(first.skippedAlreadyQueued).toBe(0);

    const second = enqueueSelectedItems([item], { get: () => null }, 3);
    expect(second.enqueued).toBe(0);
    expect(second.skippedAlreadyQueued).toBe(1);
    expect(jobQueue.pendingCount()).toBe(1);
  });

  it("skips an item with an in-flight job for the same key", () => {
    const item = selectable("K1", {
      getField: (f) => (f === "url" ? "https://example.com/paper" : ""),
    });
    enqueueSelectedItems([item], { get: () => null }, 3);
    jobQueue.takeBatch(10); // move the job from pending to in-flight

    const result = enqueueSelectedItems([item], { get: () => null }, 3);
    expect(result.enqueued).toBe(0);
    expect(result.skippedAlreadyQueued).toBe(1);
  });

  it("allows re-enqueuing an item once its prior job is done or failed", () => {
    const item = selectable("K1", {
      getField: (f) => (f === "url" ? "https://example.com/paper" : ""),
    });
    enqueueSelectedItems([item], { get: () => null }, 3);
    const [job] = jobQueue.takeBatch(10);
    jobQueue.complete(job.jobId);

    const result = enqueueSelectedItems([item], { get: () => null }, 3);
    expect(result.enqueued).toBe(1);
    expect(result.skippedAlreadyQueued).toBe(0);
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
