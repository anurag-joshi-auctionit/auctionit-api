import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  additionalFieldsImportJobs,
  type AdditionalFieldsImportJobStatus,
} from "../db/schema/index.js";
import { deleteObject, getObjectBuffer } from "../lib/r2.js";
import {
  auctionAdditionalFieldsService,
  type AdditionalFieldsImportResult,
} from "./auction-additional-fields.service.js";

/** How often the in-process ticker drains this queue. */
export const ADDITIONAL_FIELDS_IMPORT_TICK_MS = 5_000;
const MAX_ATTEMPTS = 3;
const STUCK_MS = 10 * 60_000; // 10 minutes

type ClaimedJob = {
  id: number;
  auction_id: number;
  file_key: string;
  attempts: number;
  created_by: number;
};

export type AdditionalFieldsImportJobView = {
  id: number;
  auctionId: number;
  status: AdditionalFieldsImportJobStatus;
  result: AdditionalFieldsImportResult | null;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
};

function backoffMinutes(attempts: number): number {
  return Math.min(30, 2 ** Math.max(0, attempts - 1));
}

function toView(
  row: typeof additionalFieldsImportJobs.$inferSelect,
): AdditionalFieldsImportJobView {
  return {
    id: row.id,
    auctionId: row.auctionId,
    status: row.status,
    result: (row.result as AdditionalFieldsImportResult | null) ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

export class AdditionalFieldsImportJobsService {
  /** Enqueues a job for a file already uploaded to R2 at `fileKey`. */
  async enqueue(input: {
    auctionId: number;
    fileKey: string;
    userId: number;
  }): Promise<{ id: number }> {
    const [row] = await db
      .insert(additionalFieldsImportJobs)
      .values({
        auctionId: input.auctionId,
        fileKey: input.fileKey,
        createdBy: input.userId,
      })
      .returning({ id: additionalFieldsImportJobs.id });
    return { id: row!.id };
  }

  async getStatus(jobId: number): Promise<AdditionalFieldsImportJobView | null> {
    const [row] = await db
      .select()
      .from(additionalFieldsImportJobs)
      .where(eq(additionalFieldsImportJobs.id, jobId));
    return row ? toView(row) : null;
  }

  /** Puts jobs whose worker died mid-run back in the queue. */
  private async reclaimStuck(): Promise<void> {
    await db.execute(sql`
      UPDATE additional_fields_import_jobs
      SET status = 'queued', next_attempt_at = now(), updated_at = now()
      WHERE status = 'running'
        AND COALESCE(updated_at, started_at) < now() - (${STUCK_MS} * interval '1 millisecond')
    `);
  }

  private async claim(limit: number): Promise<ClaimedJob[]> {
    const res = await db.execute<ClaimedJob>(sql`
      UPDATE additional_fields_import_jobs
      SET status = 'running', attempts = attempts + 1,
          started_at = now(), updated_at = now(), last_error = NULL
      WHERE id IN (
        SELECT id FROM additional_fields_import_jobs
        WHERE status = 'queued' AND next_attempt_at <= now()
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      RETURNING id, auction_id, file_key, attempts, created_by
    `);
    return res.rows;
  }

  /** One worker pass: reclaim stuck jobs, then process claimed jobs one by one. */
  async tick(limit = 2): Promise<{ processed: number; failed: number }> {
    await this.reclaimStuck();
    const jobs = await this.claim(limit);
    let processed = 0;
    let failed = 0;
    for (const job of jobs) {
      try {
        await this.run(job);
        processed += 1;
      } catch (err) {
        failed += 1;
        await this.markError(job, err);
      }
    }
    return { processed, failed };
  }

  private async run(job: ClaimedJob): Promise<void> {
    const buffer = await getObjectBuffer(job.file_key);
    const result = await auctionAdditionalFieldsService.importXlsx(
      job.auction_id,
      buffer,
      job.created_by,
    );
    await db.execute(sql`
      UPDATE additional_fields_import_jobs
      SET status = 'done', result = ${JSON.stringify(result)}::jsonb,
          finished_at = now(), updated_at = now()
      WHERE id = ${job.id}
    `);
    await deleteObject(job.file_key).catch((e) => {
      console.error("[additional-fields-import] failed to delete temp upload", job.file_key, e);
    });
  }

  private async markError(job: ClaimedJob, err: unknown): Promise<void> {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    const giveUp = job.attempts >= MAX_ATTEMPTS;
    console.error(`additional-fields import job ${job.id} (auction ${job.auction_id}) failed`, err);
    await db.execute(sql`
      UPDATE additional_fields_import_jobs
      SET status = ${giveUp ? "failed" : "queued"},
          last_error = ${message},
          next_attempt_at = now() + (${backoffMinutes(job.attempts)} * interval '1 minute'),
          finished_at = ${giveUp ? sql`now()` : sql`NULL`},
          updated_at = now()
      WHERE id = ${job.id}
    `);
    if (giveUp) {
      await deleteObject(job.file_key).catch(() => {});
    }
  }
}

export const additionalFieldsImportJobsService = new AdditionalFieldsImportJobsService();
