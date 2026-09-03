import { describe, expect, it } from "vitest";
import { JobQueue, type QueueClock } from "@/core/queue";

function fakeClock(startMs = 0): QueueClock & { advance(ms: number): void } {
  let now = startMs;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

function idGen(): () => string {
  let n = 0;
  return () => `job-${n++}`;
}

describe("JobQueue", () => {
  it("enqueues jobs and hands out at most batchSize pending jobs", () => {
    const q = new JobQueue({ idGenerator: idGen() });
    for (let i = 0; i < 5; i++) {
      q.enqueue({
        url: `https://example.com/${i}`,
        itemKey: `K${i}`,
        libraryID: 1,
      });
    }

    const batch1 = q.takeBatch(3);
    expect(batch1).toHaveLength(3);
    expect(batch1.map((j) => j.itemKey)).toEqual(["K0", "K1", "K2"]);
    expect(q.pendingCount()).toBe(2);
    expect(q.inFlightCount()).toBe(3);

    const batch2 = q.takeBatch(3);
    expect(batch2).toHaveLength(2);
    expect(batch2.map((j) => j.itemKey)).toEqual(["K3", "K4"]);
    expect(q.pendingCount()).toBe(0);
    expect(q.inFlightCount()).toBe(5);
  });

  it("defaults batchSize behavior: never returns more than requested even with more pending", () => {
    const q = new JobQueue({ idGenerator: idGen() });
    for (let i = 0; i < 30; i++) {
      q.enqueue({ url: "u", itemKey: `K${i}`, libraryID: 1 });
    }
    const batch = q.takeBatch(25);
    expect(batch).toHaveLength(25);
    expect(q.pendingCount()).toBe(5);
  });

  it("marks a job complete and it is not handed out again", () => {
    const q = new JobQueue({ idGenerator: idGen() });
    const id = q.enqueue({ url: "u", itemKey: "K0", libraryID: 1 });
    q.takeBatch(10);
    q.complete(id);
    expect(q.get(id)?.status).toBe("done");
    expect(q.takeBatch(10)).toHaveLength(0);
  });

  it("marks a job failed with a reason", () => {
    const q = new JobQueue({ idGenerator: idGen() });
    const id = q.enqueue({ url: "u", itemKey: "K0", libraryID: 1 });
    q.takeBatch(10);
    q.fail(id, "network error");
    expect(q.get(id)?.status).toBe("failed");
    expect(q.get(id)?.error).toBe("network error");
  });

  it("returns an abandoned in-flight job to pending after the timeout", () => {
    const clock = fakeClock();
    const q = new JobQueue({ idGenerator: idGen(), clock, timeoutMs: 1000 });
    const id = q.enqueue({ url: "u", itemKey: "K0", libraryID: 1 });
    q.takeBatch(10);
    expect(q.inFlightCount()).toBe(1);

    clock.advance(500);
    expect(q.reclaimAbandoned()).toHaveLength(0);
    expect(q.inFlightCount()).toBe(1);

    clock.advance(600); // total 1100ms > 1000ms timeout
    const reclaimed = q.reclaimAbandoned();
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].jobId).toBe(id);
    expect(q.pendingCount()).toBe(1);
    expect(q.inFlightCount()).toBe(0);
  });

  it("takeBatch itself reclaims abandoned jobs before handing out a new batch", () => {
    const clock = fakeClock();
    const q = new JobQueue({ idGenerator: idGen(), clock, timeoutMs: 100 });
    q.enqueue({ url: "u", itemKey: "K0", libraryID: 1 });
    q.takeBatch(10); // now in-flight
    clock.advance(200);
    const batch = q.takeBatch(10); // should reclaim K0 and hand it out again
    expect(batch).toHaveLength(1);
    expect(batch[0].itemKey).toBe("K0");
  });

  it("does not hand out a job twice concurrently", () => {
    const q = new JobQueue({ idGenerator: idGen() });
    q.enqueue({ url: "u", itemKey: "K0", libraryID: 1 });
    q.enqueue({ url: "u", itemKey: "K1", libraryID: 1 });

    const batch1 = q.takeBatch(1);
    expect(batch1).toHaveLength(1);
    const batch2 = q.takeBatch(1);
    expect(batch2).toHaveLength(1);
    expect(batch1[0].jobId).not.toBe(batch2[0].jobId);
  });
});
