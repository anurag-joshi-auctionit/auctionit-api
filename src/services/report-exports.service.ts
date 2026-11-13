import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { AdminReportsMessages } from "@auctionit/messages/reports";

/**
 * In-memory async report exports. Nothing is persisted: the finished workbook
 * lives in this process until downloaded, discarded, or expired. The API runs
 * as a single process, so an in-process registry is sufficient; a restart
 * drops in-flight jobs and the client reports the interruption.
 */

export type ReportExportType = "revenue" | "lifting";

export type ReportExportStatus = "running" | "completed" | "failed";

export type ReportExportEvent =
  | { type: "progress"; percent: number; label: string }
  | { type: "complete"; jobId: string; fileName: string }
  | { type: "error"; message: string };

export type ReportExportSnapshot = {
  jobId: string;
  reportType: ReportExportType;
  status: ReportExportStatus;
  percent: number;
  label: string;
  fileName: string | null;
  error: string | null;
};

type ReportExportJob = ReportExportSnapshot & {
  userId: number;
  buffer: Buffer | null;
  evictTimer: NodeJS.Timeout | null;
};

export type ReportExportProgressFn = (percent: number, label: string) => void;

export type ReportExportRunResult = { buffer: Buffer; fileName: string };

const RESULT_TTL_MS = 15 * 60 * 1000;
const MAX_CONCURRENT_JOBS = 2;

export class ReportExportConflictError extends Error {
  constructor() {
    super(AdminReportsMessages.REPORT_EXPORT_ALREADY_RUNNING);
    this.name = "ReportExportConflictError";
  }
}

export class ReportExportBusyError extends Error {
  constructor() {
    super(AdminReportsMessages.REPORT_EXPORT_SERVER_BUSY);
    this.name = "ReportExportBusyError";
  }
}

export type ReportExportDownload =
  | { kind: "ready"; buffer: Buffer; fileName: string }
  | { kind: "not_found" }
  | { kind: "not_ready" }
  | { kind: "gone" };

const jobs = new Map<string, ReportExportJob>();
const bus = new EventEmitter();
bus.setMaxListeners(0);

function channel(jobId: string): string {
  return `job:${jobId}`;
}

function snapshot(job: ReportExportJob): ReportExportSnapshot {
  return {
    jobId: job.jobId,
    reportType: job.reportType,
    status: job.status,
    percent: job.percent,
    label: job.label,
    fileName: job.fileName,
    error: job.error,
  };
}

function scheduleEviction(job: ReportExportJob) {
  if (job.evictTimer) clearTimeout(job.evictTimer);
  job.evictTimer = setTimeout(() => {
    jobs.delete(job.jobId);
  }, RESULT_TTL_MS);
  job.evictTimer.unref();
}

function removeJob(job: ReportExportJob) {
  if (job.evictTimer) clearTimeout(job.evictTimer);
  job.buffer = null;
  jobs.delete(job.jobId);
}

function ownedJob(jobId: string, userId: number): ReportExportJob | null {
  const job = jobs.get(jobId);
  return job && job.userId === userId ? job : null;
}

function runningCount(): number {
  let n = 0;
  for (const job of jobs.values()) if (job.status === "running") n += 1;
  return n;
}

export const reportExportsService = {
  /**
   * Registers a job and runs it on the next tick. Throws when the user already
   * has a job of this type running or the server-wide limit is reached.
   */
  start(opts: {
    userId: number;
    reportType: ReportExportType;
    initialLabel: string;
    run: (progress: ReportExportProgressFn) => Promise<ReportExportRunResult>;
  }): ReportExportSnapshot {
    for (const job of jobs.values()) {
      if (
        job.userId === opts.userId &&
        job.reportType === opts.reportType &&
        job.status === "running"
      ) {
        throw new ReportExportConflictError();
      }
    }
    if (runningCount() >= MAX_CONCURRENT_JOBS) {
      throw new ReportExportBusyError();
    }

    const job: ReportExportJob = {
      jobId: randomUUID(),
      reportType: opts.reportType,
      userId: opts.userId,
      status: "running",
      percent: 0,
      label: opts.initialLabel,
      fileName: null,
      error: null,
      buffer: null,
      evictTimer: null,
    };
    jobs.set(job.jobId, job);

    const progress: ReportExportProgressFn = (percent, label) => {
      if (job.status !== "running") return;
      job.percent = Math.max(job.percent, Math.min(99, Math.round(percent)));
      job.label = label;
      bus.emit(channel(job.jobId), {
        type: "progress",
        percent: job.percent,
        label: job.label,
      } satisfies ReportExportEvent);
    };

    setImmediate(() => {
      opts
        .run(progress)
        .then(({ buffer, fileName }) => {
          if (!jobs.has(job.jobId)) return;
          job.status = "completed";
          job.percent = 100;
          job.buffer = buffer;
          job.fileName = fileName;
          scheduleEviction(job);
          bus.emit(channel(job.jobId), {
            type: "complete",
            jobId: job.jobId,
            fileName,
          } satisfies ReportExportEvent);
        })
        .catch((err: unknown) => {
          console.error("[report-exports] job failed", job.jobId, err);
          if (!jobs.has(job.jobId)) return;
          job.status = "failed";
          job.error = AdminReportsMessages.REPORT_EXPORT_FAILED;
          scheduleEviction(job);
          bus.emit(channel(job.jobId), {
            type: "error",
            message: job.error,
          } satisfies ReportExportEvent);
        });
    });

    return snapshot(job);
  },

  get(jobId: string, userId: number): ReportExportSnapshot | null {
    const job = ownedJob(jobId, userId);
    return job ? snapshot(job) : null;
  },

  /** Returns an unsubscribe function. */
  subscribe(jobId: string, listener: (event: ReportExportEvent) => void) {
    const name = channel(jobId);
    bus.on(name, listener);
    return () => {
      bus.off(name, listener);
    };
  },

  /** Hands over the workbook; call `release` once it has been sent. */
  download(jobId: string, userId: number): ReportExportDownload {
    const job = ownedJob(jobId, userId);
    if (!job) return { kind: "not_found" };
    if (job.status === "running") return { kind: "not_ready" };
    if (job.status === "failed" || !job.buffer || !job.fileName) {
      return { kind: "gone" };
    }
    return { kind: "ready", buffer: job.buffer, fileName: job.fileName };
  },

  release(jobId: string, userId: number): void {
    const job = ownedJob(jobId, userId);
    if (job && job.status !== "running") removeJob(job);
  },

  /** Frees a finished job early; running jobs are left to complete. */
  discard(jobId: string, userId: number): boolean {
    const job = ownedJob(jobId, userId);
    if (!job) return false;
    if (job.status !== "running") removeJob(job);
    return true;
  },
};
