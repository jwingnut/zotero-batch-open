// Pure in-memory job queue for the remote-trigger "Save selected via
// connector" feature (see REMOTE_TRIGGER.md). Kept free of Zotero globals
// so it is easy to unit test; services/queueServer.ts wraps this with the
// actual Zotero.Server.Endpoints HTTP plumbing and item operations.

export type JobStatus = "pending" | "in-flight" | "done" | "failed";

export interface Job {
  jobId: string;
  url: string;
  itemKey: string;
  libraryID: number;
  status: JobStatus;
  enqueuedAtMs: number;
  handedOutAtMs?: number;
  error?: string;
}

/** The subset of a Job the queue endpoint hands to the connector. */
export interface QueuedJob {
  jobId: string;
  url: string;
  itemKey: string;
  libraryID: number;
}

export interface QueueClock {
  now(): number;
}

const realClock: QueueClock = { now: () => Date.now() };

export interface JobQueueOptions {
  /** How long a job may sit "in-flight" before it's returned to pending. */
  timeoutMs?: number;
  clock?: QueueClock;
  /** Injectable id generator, for deterministic tests. */
  idGenerator?: () => string;
}

function defaultIdGenerator(): string {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Default: an abandoned in-flight job returns to pending after 5 minutes. */
export const DEFAULT_JOB_TIMEOUT_MS = 5 * 60 * 1000;

export class JobQueue {
  private jobs = new Map<string, Job>();
  /** FIFO order of pending job ids only. */
  private pendingOrder: string[] = [];
  private readonly timeoutMs: number;
  private readonly clock: QueueClock;
  private readonly idGenerator: () => string;

  constructor(opts: JobQueueOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    this.clock = opts.clock ?? realClock;
    this.idGenerator = opts.idGenerator ?? defaultIdGenerator;
  }

  enqueue(job: { url: string; itemKey: string; libraryID: number }): string {
    const jobId = this.idGenerator();
    this.jobs.set(jobId, {
      jobId,
      url: job.url,
      itemKey: job.itemKey,
      libraryID: job.libraryID,
      status: "pending",
      enqueuedAtMs: this.clock.now(),
    });
    this.pendingOrder.push(jobId);
    return jobId;
  }

  /**
   * Reclaim in-flight jobs whose handout has exceeded the timeout, returning
   * them to pending (at the back of the queue). Called automatically by
   * takeBatch(), but exposed for tests / a periodic sweep.
   */
  reclaimAbandoned(): Job[] {
    const now = this.clock.now();
    const reclaimed: Job[] = [];
    for (const job of this.jobs.values()) {
      if (
        job.status === "in-flight" &&
        job.handedOutAtMs !== undefined &&
        now - job.handedOutAtMs > this.timeoutMs
      ) {
        job.status = "pending";
        job.handedOutAtMs = undefined;
        this.pendingOrder.push(job.jobId);
        reclaimed.push(job);
      }
    }
    return reclaimed;
  }

  /** Hand out up to `batchSize` pending jobs, marking them in-flight. */
  takeBatch(batchSize: number): QueuedJob[] {
    this.reclaimAbandoned();

    const taken: Job[] = [];
    const stillPending: string[] = [];

    for (const id of this.pendingOrder) {
      const job = this.jobs.get(id);
      if (!job || job.status !== "pending") {
        continue; // stale entry; job already resolved elsewhere
      }
      if (taken.length < batchSize) {
        job.status = "in-flight";
        job.handedOutAtMs = this.clock.now();
        taken.push(job);
      } else {
        stillPending.push(id);
      }
    }

    this.pendingOrder = stillPending;

    return taken.map((j) => ({
      jobId: j.jobId,
      url: j.url,
      itemKey: j.itemKey,
      libraryID: j.libraryID,
    }));
  }

  complete(jobId: string): Job | undefined {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = "done";
    }
    return job;
  }

  fail(jobId: string, reason?: string): Job | undefined {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = "failed";
      job.error = reason;
    }
    return job;
  }

  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * True if a pending or in-flight job already exists for this
   * (libraryID, itemKey) pair — used to dedupe on enqueue so re-running
   * "Save selected via connector" on the same selection does not pile up
   * duplicate jobs for the same item.
   */
  hasActiveJobForItem(libraryID: number, itemKey: string): boolean {
    for (const job of this.jobs.values()) {
      if (
        job.libraryID === libraryID &&
        job.itemKey === itemKey &&
        (job.status === "pending" || job.status === "in-flight")
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Empties all pending and in-flight jobs (used by the "Clear the
   * connector queue" command to recover from a stuck state without
   * restarting Zotero). Done/failed jobs are left in place — they are
   * already inert and kept only for get()-based lookups shortly after
   * completion.
   */
  clear(): { pendingCleared: number; inFlightCleared: number } {
    let pendingCleared = 0;
    let inFlightCleared = 0;
    for (const [id, job] of this.jobs) {
      if (job.status === "pending") {
        pendingCleared += 1;
        this.jobs.delete(id);
      } else if (job.status === "in-flight") {
        inFlightCleared += 1;
        this.jobs.delete(id);
      }
    }
    this.pendingOrder = this.pendingOrder.filter((id) => this.jobs.has(id));
    return { pendingCleared, inFlightCleared };
  }

  pendingCount(): number {
    return this.pendingOrder.filter((id) => {
      const job = this.jobs.get(id);
      return job?.status === "pending";
    }).length;
  }

  inFlightCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "in-flight") count += 1;
    }
    return count;
  }

  /** Test/debug helper: total number of jobs ever enqueued (any status). */
  size(): number {
    return this.jobs.size;
  }
}
