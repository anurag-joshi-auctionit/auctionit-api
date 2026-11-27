import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { formatUtcNow } from "@auctionit/lib/date";
import { db } from "../db/index.js";
import { bidderBankAccountLogs } from "../db/schema/bidder-bank-account-logs.js";
import { bidders } from "../db/schema/bidders.js";
import { EMAIL_SOURCE_TYPE_BANK_CHANGE_REQUEST } from "../db/schema/notification-email-logs.js";
import { NOTIFICATION_TYPE_ADHOC_SEND } from "../db/schema/notification-types.js";
import { users } from "../db/schema/users.js";
import { clampPagination } from "./list-query.js";

const requestedByUser = alias(users, "requested_by_user");
const reviewedByUser = alias(users, "reviewed_by_user");
import {
  CANCELLED_CHEQUE_PENDING_PREFIX,
  buildNewBidderDocumentFileName,
  pendingCancelledChequeToLiveFileName,
} from "../lib/bidder-document-naming.js";
import {
  buildBankAccountUpdateDecisionHtml,
  buildBankAccountUpdateDecisionSubject,
  buildBankAccountUpdateSubmittedHtml,
  buildBankAccountUpdateSubmittedSubject,
} from "../lib/bidders/bank-account-update-email-template.js";
import {
  bidderR2ObjectKey,
  BIDDER_DOCUMENT_ALLOWED_EXTENSIONS,
  contentTypeForBidderFileName,
} from "../lib/bidder-r2-keys.js";
import { fileUploadService, FileValidationError } from "./file-upload.service.js";
import { MAX_BIDDER_DOCUMENT_BYTES } from "./bidder-documents.service.js";
import { decryptField, encryptField } from "../lib/field-encryption.js";
import { getSignedDownloadUrl, renameObject } from "../lib/r2.js";
import {
  bidderBankAccountsService,
  type BidderBankAccountView,
} from "./bidder-bank-accounts.service.js";
import { insertCancelledChequeDocumentLog } from "./bidder-documents.service.js";
import { biddersService } from "./bidders.service.js";
import { enqueueEmail } from "./email-dispatch.service.js";

export type BankAccountLogDecision = "pending" | "accepted" | "rejected";

export type BankAccountLogView = {
  id: number;
  bidderId: number;
  companyName: string | null;
  bankAccount: string;
  bankName: string;
  bankIfsc: string;
  cancelledChequeFileName: string;
  cancelledChequeUrl: string | null;
  isVerified: boolean | null;
  requestedAt: string;
  requestedBy: number | null;
  requestedByName: string | null;
  reviewedAt: string | null;
  reviewedBy: number | null;
  reviewedByName: string | null;
  reviewRemark: string | null;
};

export type BankAccountLogCounts = {
  pending: number;
  accepted: number;
  rejected: number;
};

export type BankAccountLogHistoryItem = {
  id: number;
  bankAccount: string;
  bankName: string;
  bankIfsc: string;
  isVerified: boolean | null;
  requestedAt: string;
  reviewedAt: string | null;
};

export type SubmitBankAccountLogInput = {
  bankAccount: string;
  bankName: string;
  bankIfsc: string;
  cheque: {
    buffer: Buffer;
    originalFilename: string;
  };
};

export class BankAccountLogNotFoundError extends Error {
  constructor() {
    super("BANK_UPDATE_NOT_FOUND");
    this.name = "BankAccountLogNotFoundError";
  }
}

export class BankAccountLogNotPendingError extends Error {
  constructor() {
    super("BANK_UPDATE_NOT_PENDING");
    this.name = "BankAccountLogNotPendingError";
  }
}

export class BankAccountLogAlreadyPendingError extends Error {
  constructor() {
    super("BANK_UPDATE_ALREADY_PENDING");
    this.name = "BankAccountLogAlreadyPendingError";
  }
}

export class ChequeFileInvalidError extends Error {
  constructor() {
    super("INVALID_CHEQUE_FILE");
    this.name = "ChequeFileInvalidError";
  }
}

export class ChequeFileTooLargeError extends Error {
  constructor() {
    super("CHEQUE_FILE_TOO_LARGE");
    this.name = "ChequeFileTooLargeError";
  }
}


async function mapLogRow(row: {
  id: number;
  bidderId: number;
  bankAccount: string;
  bankName: string;
  bankIfsc: string;
  cancelledChequeFileName: string;
  cancelledChequeS3Key: string;
  isVerified: boolean | null;
  requestedAt: string;
  requestedBy: number | null;
  reviewedAt: string | null;
  reviewedBy: number | null;
  reviewRemark: string | null;
  companyName?: string | null;
  requestedByName?: string | null;
  reviewedByName?: string | null;
}): Promise<BankAccountLogView> {
  let cancelledChequeUrl: string | null = null;
  try {
    cancelledChequeUrl = await getSignedDownloadUrl(row.cancelledChequeS3Key, {
      contentDisposition: "inline",
      contentType: contentTypeForBidderFileName(row.cancelledChequeFileName),
    });
  } catch {
    cancelledChequeUrl = null;
  }

  return {
    id: row.id,
    bidderId: row.bidderId,
    companyName: row.companyName ?? null,
    bankAccount: decryptField(row.bankAccount) ?? "",
    bankName: decryptField(row.bankName) ?? "",
    bankIfsc: decryptField(row.bankIfsc) ?? "",
    cancelledChequeFileName: row.cancelledChequeFileName,
    cancelledChequeUrl,
    isVerified: row.isVerified,
    requestedAt: row.requestedAt,
    requestedBy: row.requestedBy ?? null,
    requestedByName: row.requestedByName ?? null,
    reviewedAt: row.reviewedAt ?? null,
    reviewedBy: row.reviewedBy ?? null,
    reviewedByName: row.reviewedByName ?? null,
    reviewRemark: row.reviewRemark ?? null,
  };
}

function bankUpdateDateRange(
  dateField: "requestedAt" | "reviewedAt" | undefined,
  dateFrom: string | undefined,
  dateTo: string | undefined,
) {
  if (!dateField || !dateFrom) return undefined;
  const column =
    dateField === "reviewedAt"
      ? bidderBankAccountLogs.reviewedAt
      : bidderBankAccountLogs.requestedAt;
  if (dateTo) {
    return sql`${column}::date >= CAST(${dateFrom} AS date) AND ${column}::date <= CAST(${dateTo} AS date)`;
  }
  return sql`${column}::date >= CAST(${dateFrom} AS date)`;
}

export class BidderBankAccountLogsService {
  async getPendingForBidder(
    bidderId: number,
  ): Promise<BankAccountLogView | null> {
    await biddersService.requireBidder(bidderId);

    const [row] = await db
      .select({
        ...getTableColumns(bidderBankAccountLogs),
        companyName: bidders.companyName,
      })
      .from(bidderBankAccountLogs)
      .innerJoin(bidders, eq(bidders.id, bidderBankAccountLogs.bidderId))
      .where(
        and(
          eq(bidderBankAccountLogs.bidderId, bidderId),
          isNull(bidderBankAccountLogs.isVerified),
        ),
      )
      .limit(1);

    if (!row) return null;
    return mapLogRow(row);
  }

  async getPortalSummary(bidderId: number): Promise<{
    account: BidderBankAccountView | null;
    pendingRequest: BankAccountLogView | null;
  }> {
    const [account, pendingRequest] = await Promise.all([
      bidderBankAccountsService.getByBidderId(bidderId),
      this.getPendingForBidder(bidderId),
    ]);
    return { account, pendingRequest };
  }

  async listForBidder(bidderId: number): Promise<BankAccountLogHistoryItem[]> {
    await biddersService.requireBidder(bidderId);

    const rows = await db
      .select({
        id: bidderBankAccountLogs.id,
        bankAccount: bidderBankAccountLogs.bankAccount,
        bankName: bidderBankAccountLogs.bankName,
        bankIfsc: bidderBankAccountLogs.bankIfsc,
        isVerified: bidderBankAccountLogs.isVerified,
        requestedAt: bidderBankAccountLogs.requestedAt,
        reviewedAt: bidderBankAccountLogs.reviewedAt,
      })
      .from(bidderBankAccountLogs)
      .where(eq(bidderBankAccountLogs.bidderId, bidderId))
      .orderBy(desc(bidderBankAccountLogs.requestedAt));

    return rows.map((row) => ({
      id: row.id,
      bankAccount: decryptField(row.bankAccount) ?? "",
      bankName: decryptField(row.bankName) ?? "",
      bankIfsc: decryptField(row.bankIfsc) ?? "",
      isVerified: row.isVerified,
      requestedAt: row.requestedAt,
      reviewedAt: row.reviewedAt ?? null,
    }));
  }

  async submit(
    bidderId: number,
    input: SubmitBankAccountLogInput,
    userId: number,
  ): Promise<BankAccountLogView> {
    await biddersService.requireBidder(bidderId);

    const existingPending = await this.getPendingForBidder(bidderId);
    if (existingPending) {
      throw new BankAccountLogAlreadyPendingError();
    }

    const now = formatUtcNow();
    let cheque: Awaited<ReturnType<typeof fileUploadService.upload>>;
    try {
      cheque = await fileUploadService.upload(
        { buffer: input.cheque.buffer, originalFilename: input.cheque.originalFilename },
        {
          folder: "bidders",
          buildFileName: (orig) =>
            buildNewBidderDocumentFileName({
              prefix: CANCELLED_CHEQUE_PENDING_PREFIX,
              bidderId,
              originalFileName: orig,
            }),
          minSizeBytes: 1,
          maxSizeBytes: MAX_BIDDER_DOCUMENT_BYTES,
          allowedExtensions: [...BIDDER_DOCUMENT_ALLOWED_EXTENSIONS],
        },
      );
    } catch (err) {
      if (err instanceof FileValidationError) {
        if (err.message.includes("exceeds")) throw new ChequeFileTooLargeError();
        throw new ChequeFileInvalidError();
      }
      throw err;
    }

    const [inserted] = await db
      .insert(bidderBankAccountLogs)
      .values({
        bidderId,
        bankAccount: encryptField(input.bankAccount)!,
        bankName: encryptField(input.bankName)!,
        bankIfsc: encryptField(input.bankIfsc)!,
        cancelledChequeFileName: cheque.fileName,
        cancelledChequeS3Key: cheque.s3Key,
        isVerified: null,
        requestedAt: now,
        requestedBy: userId,
      })
      .returning();

    if (!inserted) throw new Error("BANK_UPDATE_INSERT_FAILED");

    // Raising an update request means current live details are no longer trusted.
    await bidderBankAccountsService.markUnverifiedForPendingUpdate(
      bidderId,
      userId,
    );

    await biddersService.markUnverified(bidderId, userId);

    void this.notifyBidderSubmitted(bidderId, inserted.id).catch(() => {});

    return this.requireView(inserted.id);
  }

  async countsForAdmin(): Promise<BankAccountLogCounts> {
    const rows = await db
      .select({
        isVerified: bidderBankAccountLogs.isVerified,
        total: count(),
      })
      .from(bidderBankAccountLogs)
      .groupBy(bidderBankAccountLogs.isVerified);

    const counts: BankAccountLogCounts = {
      pending: 0,
      accepted: 0,
      rejected: 0,
    };
    for (const row of rows) {
      if (row.isVerified === null) counts.pending = Number(row.total);
      else if (row.isVerified === true) counts.accepted = Number(row.total);
      else counts.rejected = Number(row.total);
    }
    return counts;
  }

  async listForAdmin(opts?: {
    decision?: BankAccountLogDecision;
    search?: string;
    bidderId?: number;
    dateField?: "requestedAt" | "reviewedAt";
    dateFrom?: string;
    dateTo?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{
    items: BankAccountLogView[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const decision = opts?.decision ?? "pending";
    const search = opts?.search?.trim();
    const { page, pageSize, offset } = clampPagination(
      opts?.page ?? 1,
      opts?.pageSize ?? 10,
    );

    const decisionCond =
      decision === "pending"
        ? isNull(bidderBankAccountLogs.isVerified)
        : decision === "accepted"
          ? eq(bidderBankAccountLogs.isVerified, true)
          : eq(bidderBankAccountLogs.isVerified, false);

    const conditions = [decisionCond];
    if (opts?.bidderId != null) {
      conditions.push(eq(bidderBankAccountLogs.bidderId, opts.bidderId));
    }
    if (search) {
      const asId = Number(search);
      const searchCond = or(
        ilike(bidders.companyName, `%${search}%`),
        Number.isInteger(asId) && asId > 0
          ? eq(bidderBankAccountLogs.bidderId, asId)
          : sql`false`,
      );
      if (searchCond) conditions.push(searchCond);
    }

    const dateCond = bankUpdateDateRange(
      opts?.dateField,
      opts?.dateFrom,
      opts?.dateTo,
    );
    if (dateCond) conditions.push(dateCond);

    const whereExpr = and(...conditions);

    const [rows, totalRow] = await Promise.all([
      db
        .select({
          ...getTableColumns(bidderBankAccountLogs),
          companyName: bidders.companyName,
          requestedByName: requestedByUser.name,
          reviewedByName: reviewedByUser.name,
        })
        .from(bidderBankAccountLogs)
        .innerJoin(bidders, eq(bidders.id, bidderBankAccountLogs.bidderId))
        .leftJoin(
          requestedByUser,
          eq(requestedByUser.id, bidderBankAccountLogs.requestedBy),
        )
        .leftJoin(
          reviewedByUser,
          eq(reviewedByUser.id, bidderBankAccountLogs.reviewedBy),
        )
        .where(whereExpr)
        .orderBy(desc(bidderBankAccountLogs.requestedAt))
        .limit(pageSize)
        .offset(offset),
      db
        .select({ total: count() })
        .from(bidderBankAccountLogs)
        .innerJoin(bidders, eq(bidders.id, bidderBankAccountLogs.bidderId))
        .where(whereExpr)
        .then((r) => r[0]),
    ]);

    const items = await Promise.all(rows.map((row) => mapLogRow(row)));
    return {
      items,
      total: Number(totalRow?.total ?? 0),
      page,
      pageSize,
    };
  }

  async accept(logId: number, userId: number): Promise<BankAccountLogView> {
    const [existing] = await db
      .select()
      .from(bidderBankAccountLogs)
      .where(eq(bidderBankAccountLogs.id, logId))
      .limit(1);

    if (!existing) throw new BankAccountLogNotFoundError();
    if (existing.isVerified !== null) {
      throw new BankAccountLogNotPendingError();
    }

    const bankAccount = decryptField(existing.bankAccount);
    const bankName = decryptField(existing.bankName);
    const bankIfsc = decryptField(existing.bankIfsc);
    if (!bankAccount || !bankName || !bankIfsc) {
      throw new Error("BANK_UPDATE_CORRUPT");
    }

    const liveFileName = pendingCancelledChequeToLiveFileName(
      existing.cancelledChequeFileName,
    );
    const fromKey = existing.cancelledChequeS3Key;
    const toKey = bidderR2ObjectKey(liveFileName);

    await renameObject({ fromKey, toKey });

    const now = formatUtcNow();

    await bidderBankAccountsService.applyVerifiedDetails(
      existing.bidderId,
      { bankAccount, bankName, bankIfsc },
      userId,
    );

    await insertCancelledChequeDocumentLog({
      bidderId: existing.bidderId,
      s3Key: toKey,
      storageFileName: liveFileName,
      userId,
      createdAt: now,
    });

    await db
      .update(bidderBankAccountLogs)
      .set({
        cancelledChequeFileName: liveFileName,
        cancelledChequeS3Key: toKey,
        isVerified: true,
        reviewedAt: now,
        reviewedBy: userId,
        reviewRemark: null,
      })
      .where(eq(bidderBankAccountLogs.id, logId));

    void this.notifyBidderDecision(existing.bidderId, logId, "accepted").catch(
      () => {},
    );

    return this.requireView(logId);
  }

  async reject(
    logId: number,
    userId: number,
    remark?: string | null,
  ): Promise<BankAccountLogView> {
    const [existing] = await db
      .select()
      .from(bidderBankAccountLogs)
      .where(eq(bidderBankAccountLogs.id, logId))
      .limit(1);

    if (!existing) throw new BankAccountLogNotFoundError();
    if (existing.isVerified !== null) {
      throw new BankAccountLogNotPendingError();
    }

    const now = formatUtcNow();
    await db
      .update(bidderBankAccountLogs)
      .set({
        isVerified: false,
        reviewedAt: now,
        reviewedBy: userId,
        reviewRemark: remark?.trim() || null,
      })
      .where(eq(bidderBankAccountLogs.id, logId));

    void this.notifyBidderDecision(existing.bidderId, logId, "rejected").catch(
      () => {},
    );

    return this.requireView(logId);
  }

  private async requireView(id: number): Promise<BankAccountLogView> {
    const [row] = await db
      .select({
        ...getTableColumns(bidderBankAccountLogs),
        companyName: bidders.companyName,
        requestedByName: requestedByUser.name,
        reviewedByName: reviewedByUser.name,
      })
      .from(bidderBankAccountLogs)
      .innerJoin(bidders, eq(bidders.id, bidderBankAccountLogs.bidderId))
      .leftJoin(
        requestedByUser,
        eq(requestedByUser.id, bidderBankAccountLogs.requestedBy),
      )
      .leftJoin(
        reviewedByUser,
        eq(reviewedByUser.id, bidderBankAccountLogs.reviewedBy),
      )
      .where(eq(bidderBankAccountLogs.id, id))
      .limit(1);

    if (!row) throw new BankAccountLogNotFoundError();
    return mapLogRow(row);
  }

  private async notifyBidderSubmitted(
    bidderId: number,
    logId: number,
  ): Promise<void> {
    const [row] = await db
      .select({
        companyName: bidders.companyName,
        email: users.emailId,
      })
      .from(bidders)
      .innerJoin(
        users,
        and(eq(users.bidderId, bidders.id), eq(users.isActive, true)),
      )
      .where(eq(bidders.id, bidderId))
      .limit(1);
    const to = row?.email?.trim();
    if (!to || !row) return;

    await enqueueEmail({
      notificationId: NOTIFICATION_TYPE_ADHOC_SEND,
      emailTo: to,
      subject: buildBankAccountUpdateSubmittedSubject(),
      emailBody: buildBankAccountUpdateSubmittedHtml({
        companyName: row.companyName,
      }),
      sourceType: EMAIL_SOURCE_TYPE_BANK_CHANGE_REQUEST,
      sourceId: logId,
    });
  }

  private async notifyBidderDecision(
    bidderId: number,
    logId: number,
    decision: "accepted" | "rejected",
  ): Promise<void> {
    const [row] = await db
      .select({
        companyName: bidders.companyName,
        email: users.emailId,
      })
      .from(bidders)
      .innerJoin(
        users,
        and(eq(users.bidderId, bidders.id), eq(users.isActive, true)),
      )
      .where(eq(bidders.id, bidderId))
      .limit(1);
    const to = row?.email?.trim();
    if (!to || !row) return;

    await enqueueEmail({
      notificationId: NOTIFICATION_TYPE_ADHOC_SEND,
      emailTo: to,
      subject: buildBankAccountUpdateDecisionSubject(decision),
      emailBody: buildBankAccountUpdateDecisionHtml({
        companyName: row.companyName,
        decision,
      }),
      sourceType: EMAIL_SOURCE_TYPE_BANK_CHANGE_REQUEST,
      sourceId: logId,
    });
  }
}

export const bidderBankAccountLogsService = new BidderBankAccountLogsService();
