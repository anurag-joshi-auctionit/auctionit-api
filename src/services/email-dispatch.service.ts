import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  EMAIL_SOURCE_TYPE_LOT_CONFIRMATION,
  EMAIL_SOURCE_TYPE_SERVICE_INVOICE,
  EMAIL_SOURCE_TYPE_SUBSCRIPTION,
  notificationEmailLogs,
  type EmailAttachmentRef,
} from "../db/schema/notification-email-logs.js";
import {
  NOTIFICATION_TYPE_LOT_CONFIRMATION,
  NOTIFICATION_TYPE_SERVICE_INVOICE_ANNEXURE,
  NOTIFICATION_TYPE_SUBSCRIPTION_ANNEXURE,
} from "../db/schema/notification-types.js";
import { auctionLotConfirmationDocuments } from "../db/schema/auction-lot-confirmation-documents.js";
import { serviceInvoices } from "../db/schema/service-invoices.js";
import { subscriptions } from "../db/schema/subscriptions.js";
import { env } from "../env.js";
import { sendMail } from "../lib/email.js";
import { RateLimiter } from "../lib/rate-limiter.js";
import { getObjectBuffer } from "../lib/r2.js";
import { formatUtcNow } from "@auctionit/lib/date";

export type { EmailAttachmentRef };

export type EnqueueEmailInput = {
  notificationId: number;
  emailTo: string;
  emailCc?: string | null;
  emailBcc?: string | null;
  emailBody: string;
  /** Rendered subject — persisted so retries send the same text. */
  subject: string;
  auctionId?: number | null;
  attachments?: EmailAttachmentRef[];
  requiresAttachment?: boolean;
  sourceType?: string | null;
  sourceId?: number | null;
  enqueuedBy?: number | null;
};

type ClaimedRow = {
  id: number;
  notification_id: number;
  email_to: string;
  email_cc: string | null;
  email_bcc: string | null;
  email_body: string;
  subject: string;
  attachments: EmailAttachmentRef[] | null;
  requires_attachment: boolean;
  attempts: number;
  source_type: string | null;
  source_id: number | null;
  enqueued_by: number | null;
};

const MAX_ATTEMPTS = () => env.EMAIL_DISPATCH_MAX_ATTEMPTS;
const LAST_ERROR_MAX = 1000;

let rateLimiter: RateLimiter | null = null;

function limiter(): RateLimiter {
  if (!rateLimiter) {
    rateLimiter = new RateLimiter(env.EMAIL_RATE_PER_SECOND);
  }
  return rateLimiter;
}

function normalizeAuctionId(
  auctionId: number | null | undefined,
): number | null {
  if (auctionId == null || auctionId === 0) return null;
  return auctionId;
}

function truncateError(message: string): string {
  if (message.length <= LAST_ERROR_MAX) return message;
  return `${message.slice(0, LAST_ERROR_MAX - 1)}…`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return truncateError(err.message);
  return truncateError(String(err));
}

function backoffMs(attemptsAfter: number): number {
  const base = env.EMAIL_RETRY_BASE_MS;
  const max = env.EMAIL_RETRY_MAX_MS;
  const exp = Math.max(0, attemptsAfter - 1);
  return Math.min(base * 2 ** exp, max);
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const idx = next;
        next += 1;
        await worker(items[idx]!);
      }
    },
  );
  await Promise.all(runners);
}

async function resolveAttachments(
  refs: EmailAttachmentRef[],
): Promise<Array<{ content: string; filename: string; type: string }>> {
  return Promise.all(
    refs.map(async (ref) => ({
      content: (await getObjectBuffer(ref.s3Key)).toString("base64"),
      filename: ref.filename,
      type: ref.contentType,
    })),
  );
}

async function stampServiceInvoiceEmailSent(row: ClaimedRow, sentAt: string) {
  if (row.source_type !== EMAIL_SOURCE_TYPE_SERVICE_INVOICE) return;
  // Customer invoice email only — payment reminders (90/91) must not restamp.
  if (Number(row.notification_id) !== NOTIFICATION_TYPE_SERVICE_INVOICE_ANNEXURE) {
    return;
  }
  const sourceId = Number(row.source_id);
  if (!Number.isInteger(sourceId) || sourceId <= 0) return;
  const enqueuedByRaw = row.enqueued_by;
  const enqueuedBy =
    enqueuedByRaw == null ? null : Number(enqueuedByRaw);
  await db
    .update(serviceInvoices)
    .set({
      emailSentAt: sentAt,
      emailSentBy:
        enqueuedBy != null && Number.isInteger(enqueuedBy) && enqueuedBy > 0
          ? enqueuedBy
          : null,
    })
    .where(eq(serviceInvoices.id, sourceId));
}

async function stampSubscriptionEmailSent(row: ClaimedRow, sentAt: string) {
  if (row.source_type !== EMAIL_SOURCE_TYPE_SUBSCRIPTION) return;
  if (Number(row.notification_id) !== NOTIFICATION_TYPE_SUBSCRIPTION_ANNEXURE) {
    return;
  }
  const sourceId = Number(row.source_id);
  if (!Number.isInteger(sourceId) || sourceId <= 0) return;
  const enqueuedByRaw = row.enqueued_by;
  const enqueuedBy =
    enqueuedByRaw == null ? null : Number(enqueuedByRaw);
  await db
    .update(subscriptions)
    .set({
      emailSentAt: sentAt,
      emailSentBy:
        enqueuedBy != null && Number.isInteger(enqueuedBy) && enqueuedBy > 0
          ? enqueuedBy
          : null,
    })
    .where(eq(subscriptions.id, sourceId));
}

async function stampLotConfirmationEmailSent(row: ClaimedRow, sentAt: string) {
  if (row.source_type !== EMAIL_SOURCE_TYPE_LOT_CONFIRMATION) return;
  if (Number(row.notification_id) !== NOTIFICATION_TYPE_LOT_CONFIRMATION) {
    return;
  }
  const sourceId = Number(row.source_id);
  if (!Number.isInteger(sourceId) || sourceId <= 0) return;
  const enqueuedByRaw = row.enqueued_by;
  const enqueuedBy =
    enqueuedByRaw == null ? null : Number(enqueuedByRaw);
  await db
    .update(auctionLotConfirmationDocuments)
    .set({
      emailSentAt: sentAt,
      emailSentBy:
        enqueuedBy != null && Number.isInteger(enqueuedBy) && enqueuedBy > 0
          ? enqueuedBy
          : null,
    })
    .where(eq(auctionLotConfirmationDocuments.id, sourceId));
}

async function markSent(row: ClaimedRow): Promise<void> {
  const sentAt = formatUtcNow();
  await db
    .update(notificationEmailLogs)
    .set({
      status: "sent",
      sentAt,
      lastError: null,
    })
    .where(sql`${notificationEmailLogs.id} = ${row.id}`);
  await stampServiceInvoiceEmailSent(row, sentAt);
  await stampSubscriptionEmailSent(row, sentAt);
  await stampLotConfirmationEmailSent(row, sentAt);
}

async function markAttemptFailed(
  id: number,
  attemptsAfter: number,
  lastError: string,
): Promise<void> {
  const failed = attemptsAfter >= MAX_ATTEMPTS();
  const nextAttemptAt = failed
    ? formatUtcNow()
    : formatUtcNow(new Date(Date.now() + backoffMs(attemptsAfter)));
  await db
    .update(notificationEmailLogs)
    .set({
      status: failed ? "failed" : "queued",
      nextAttemptAt,
      lastError: truncateError(lastError),
    })
    .where(sql`${notificationEmailLogs.id} = ${id}`);
}

/**
 * Bulk-insert queued rows. Does not send — the worker claims and delivers.
 * Rejects inputs that require an attachment but have none.
 */
export async function enqueueEmails(
  inputs: EnqueueEmailInput[],
): Promise<{ ids: number[] }> {
  if (inputs.length === 0) return { ids: [] };

  for (const input of inputs) {
    const refs = input.attachments ?? [];
    if (input.requiresAttachment && refs.length === 0) {
      throw new Error("EMAIL_ATTACHMENT_REQUIRED");
    }
  }

  const now = formatUtcNow();
  const inserted = await db
    .insert(notificationEmailLogs)
    .values(
      inputs.map((input) => ({
        auctionId: normalizeAuctionId(input.auctionId),
        notificationId: input.notificationId,
        status: "queued" as const,
        emailTo: input.emailTo,
        emailCc: input.emailCc ?? null,
        emailBcc: input.emailBcc ?? null,
        emailBody: input.emailBody,
        subject: input.subject,
        attachments: input.attachments?.length ? input.attachments : null,
        requiresAttachment: input.requiresAttachment ?? false,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        enqueuedBy: input.enqueuedBy ?? null,
        attempts: 0,
        nextAttemptAt: now,
        lastError: null,
      })),
    )
    .returning({ id: notificationEmailLogs.id });

  if (inserted.length !== inputs.length) {
    throw new Error("EMAIL_ENQUEUE_FAILED");
  }

  return { ids: inserted.map((r) => r.id) };
}

/** Convenience wrapper for a single enqueue. */
export async function enqueueEmail(
  input: EnqueueEmailInput,
): Promise<{ id: number }> {
  const { ids } = await enqueueEmails([input]);
  const id = ids[0];
  if (id == null) throw new Error("EMAIL_ENQUEUE_FAILED");
  return { id };
}

/**
 * Claim up to `limit` ready rows with SKIP LOCKED.
 * Sets status=sending, increments attempts, stamps next_attempt_at as claim time
 * (used by reclaimStuckSending).
 */
export async function claimBatch(limit: number): Promise<ClaimedRow[]> {
  const result = await db.execute<ClaimedRow>(sql`
    UPDATE notification_email_logs
    SET
      status = 'sending',
      attempts = attempts + 1,
      next_attempt_at = now()
    WHERE id IN (
      SELECT id FROM notification_email_logs
      WHERE status = 'queued'
        AND next_attempt_at <= now()
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING
      id,
      notification_id,
      email_to,
      email_cc,
      email_bcc,
      email_body,
      subject,
      attachments,
      requires_attachment,
      attempts,
      source_type,
      source_id,
      enqueued_by
  `);
  return result.rows;
}

/**
 * Reclaim rows stuck in `sending` past the reclaim window (worker crash).
 * Uses next_attempt_at stamped at claim time.
 */
export async function reclaimStuckSending(): Promise<number> {
  const cutoff = formatUtcNow(
    new Date(Date.now() - env.EMAIL_STUCK_RECLAIM_MS),
  );
  const result = await db.execute<{ id: number }>(sql`
    UPDATE notification_email_logs
    SET
      status = 'queued',
      next_attempt_at = now(),
      last_error = coalesce(last_error, 'reclaimed after stuck sending')
    WHERE status = 'sending'
      AND next_attempt_at < ${cutoff}
    RETURNING id
  `);
  return result.rows.length;
}

async function processOne(row: ClaimedRow): Promise<void> {
  const refs = Array.isArray(row.attachments) ? row.attachments : [];
  try {
    if (row.requires_attachment && refs.length === 0) {
      throw new Error("EMAIL_ATTACHMENT_REQUIRED");
    }

    let attachments:
      | Array<{ content: string; filename: string; type: string }>
      | undefined;
    if (refs.length > 0) {
      attachments = await resolveAttachments(refs);
      if (row.requires_attachment && attachments.length === 0) {
        throw new Error("EMAIL_ATTACHMENT_REQUIRED");
      }
    }

    await limiter().take();
    await sendMail({
      to: row.email_to,
      cc: row.email_cc ?? undefined,
      bcc: row.email_bcc ?? undefined,
      subject: row.subject || "AuctionIt Notification",
      html: row.email_body,
      attachments,
    });
    await markSent(row);
  } catch (err) {
    console.error(`email dispatch failed id=${row.id}`, err);
    await markAttemptFailed(row.id, row.attempts, errorMessage(err));
  }
}

/** Send each claimed row through the rate limiter with bounded concurrency. */
export async function processClaimed(rows: ClaimedRow[]): Promise<void> {
  await mapPool(rows, env.EMAIL_DISPATCH_CONCURRENCY, processOne);
}

/** One worker tick: reclaim stuck, claim a batch, process it. Returns batch size. */
export async function runWorkerTick(): Promise<number> {
  const reclaimed = await reclaimStuckSending();
  if (reclaimed > 0) {
    console.log(`email worker reclaimed ${reclaimed} stuck sending row(s)`);
  }
  const claimed = await claimBatch(env.EMAIL_WORKER_BATCH_SIZE);
  if (claimed.length === 0) return 0;
  await processClaimed(claimed);
  return claimed.length;
}
