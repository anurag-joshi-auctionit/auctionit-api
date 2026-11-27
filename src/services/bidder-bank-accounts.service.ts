import { eq, getTableColumns, max } from "drizzle-orm";
import { db } from "../db/index.js";
import { bidderBankAccounts } from "../db/schema/bidder-bank-accounts.js";
import { users } from "../db/schema/users.js";
import { decryptField, encryptField } from "../lib/field-encryption.js";
import {
  BIDDER_DOCUMENT_TYPE_CANCELLED_CHEQUE,
  buildNewBidderDocumentFileName,
  legacyBidderDocumentTypePrefix,
} from "../lib/bidder-document-naming.js";
import { BIDDER_DOCUMENT_ALLOWED_EXTENSIONS } from "../lib/bidder-r2-keys.js";
import { fileUploadService } from "./file-upload.service.js";
import {
  getCancelledChequeSignedUrl,
  insertCancelledChequeDocumentLog,
  MAX_BIDDER_DOCUMENT_BYTES,
} from "./bidder-documents.service.js";
import { BidderNotFoundError, biddersService } from "./bidders.service.js";
import { formatUtcNow } from "@auctionit/lib/date";

export type BidderBankAccountView = {
  bankAccount: string | null;
  bankName: string | null;
  bankIfsc: string | null;
  cancelledChequeFileName: string | null;
  cancelledCheckUrl: string | null;
  isVerified: boolean;
  reviewedAt: string | null;
  reviewedBy: number | null;
  reviewedByName: string | null;
  createdAt: string;
  updatedAt: string | null;
};

export type UpsertBidderBankAccountInput = {
  bankAccount: string;
  bankName: string;
  bankIfsc: string;
  cheque?: {
    buffer: Buffer;
    originalFilename?: string;
  };
};

export class BidderBankAccountNotFoundError extends Error {
  constructor() {
    super("BANK_ACCOUNT_NOT_FOUND");
    this.name = "BidderBankAccountNotFoundError";
  }
}

export class BidderBankAccountAlreadyVerifiedError extends Error {
  constructor() {
    super("BANK_ACCOUNT_ALREADY_VERIFIED");
    this.name = "BidderBankAccountAlreadyVerifiedError";
  }
}

function mapRowToView(
  row: typeof bidderBankAccounts.$inferSelect,
  cancelledCheckUrl: string | null,
  reviewedByName: string | null,
): BidderBankAccountView {
  return {
    bankAccount: decryptField(row.bankAccount),
    bankName: decryptField(row.bankName),
    bankIfsc: decryptField(row.bankIfsc),
    cancelledChequeFileName: row.cancelledChequeFileName ?? null,
    cancelledCheckUrl,
    isVerified: row.isVerified,
    reviewedAt: row.reviewedAt ?? null,
    reviewedBy: row.reviewedBy ?? null,
    reviewedByName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? null,
  };
}

async function nextAccountId(): Promise<number> {
  const [row] = await db
    .select({ value: max(bidderBankAccounts.id) })
    .from(bidderBankAccounts);
  return (row?.value ?? 0) + 1;
}

export class BidderBankAccountsService {
  async getByBidderId(bidderId: number): Promise<BidderBankAccountView | null> {
    await biddersService.requireBidder(bidderId);

    const [result] = await db
      .select({
        ...getTableColumns(bidderBankAccounts),
        reviewedByName: users.name,
      })
      .from(bidderBankAccounts)
      .leftJoin(users, eq(users.id, bidderBankAccounts.reviewedBy))
      .where(eq(bidderBankAccounts.bidderId, bidderId));

    if (!result) return null;

    const { reviewedByName, ...row } = result;
    const cancelledCheckUrl = await getCancelledChequeSignedUrl(bidderId);
    return mapRowToView(row, cancelledCheckUrl, reviewedByName ?? null);
  }

  async upsert(
    bidderId: number,
    input: UpsertBidderBankAccountInput,
    userId: number,
  ): Promise<BidderBankAccountView> {
    await biddersService.requireBidder(bidderId);

    const now = formatUtcNow();
    const [existing] = await db
      .select()
      .from(bidderBankAccounts)
      .where(eq(bidderBankAccounts.bidderId, bidderId));

    let cancelledChequeFileName = existing?.cancelledChequeFileName ?? null;

    if (input.cheque) {
      const originalFilename = input.cheque.originalFilename ?? "cheque.jpg";
      const at = new Date();
      const uploaded = await fileUploadService.upload(
        { buffer: input.cheque.buffer, originalFilename },
        {
          folder: "bidders",
          buildFileName: (orig) =>
            buildNewBidderDocumentFileName({
              prefix: legacyBidderDocumentTypePrefix(BIDDER_DOCUMENT_TYPE_CANCELLED_CHEQUE),
              bidderId,
              originalFileName: orig,
              at,
            }),
          minSizeBytes: 1,
          maxSizeBytes: MAX_BIDDER_DOCUMENT_BYTES,
          allowedExtensions: [...BIDDER_DOCUMENT_ALLOWED_EXTENSIONS],
        },
      );

      await insertCancelledChequeDocumentLog({
        bidderId,
        s3Key: uploaded.s3Key,
        storageFileName: uploaded.fileName,
        userId,
        createdAt: formatUtcNow(at),
      });

      cancelledChequeFileName = uploaded.fileName;
    }

    const values = {
      bankAccount: encryptField(input.bankAccount),
      bankName: encryptField(input.bankName),
      bankIfsc: encryptField(input.bankIfsc),
      cancelledChequeFileName,
      updatedAt: now,
      updatedBy: userId,
    };

    if (existing) {
      await db
        .update(bidderBankAccounts)
        .set(values)
        .where(eq(bidderBankAccounts.bidderId, bidderId));
    } else {
      const id = await nextAccountId();
      await db.insert(bidderBankAccounts).values({
        id,
        bidderId,
        ...values,
        isVerified: false,
        createdAt: now,
        createdBy: userId,
      });
    }

    const result = await this.getByBidderId(bidderId);
    if (!result) {
      throw new Error("BANK_ACCOUNT_UPSERT_FAILED");
    }
    return result;
  }

  async verify(bidderId: number, userId: number): Promise<BidderBankAccountView> {
    await biddersService.requireBidder(bidderId);

    const [existing] = await db
      .select()
      .from(bidderBankAccounts)
      .where(eq(bidderBankAccounts.bidderId, bidderId));

    if (!existing) throw new BidderBankAccountNotFoundError();
    if (existing.isVerified) throw new BidderBankAccountAlreadyVerifiedError();

    const now = formatUtcNow();
    await db
      .update(bidderBankAccounts)
      .set({
        isVerified: true,
        reviewedAt: now,
        reviewedBy: userId,
        updatedAt: now,
        updatedBy: userId,
      })
      .where(eq(bidderBankAccounts.bidderId, bidderId));

    const result = await this.getByBidderId(bidderId);
    if (!result) throw new BidderBankAccountNotFoundError();
    return result;
  }

  async reject(bidderId: number, userId: number): Promise<BidderBankAccountView> {
    await biddersService.requireBidder(bidderId);

    const [existing] = await db
      .select()
      .from(bidderBankAccounts)
      .where(eq(bidderBankAccounts.bidderId, bidderId));

    if (!existing) throw new BidderBankAccountNotFoundError();
    if (existing.isVerified) throw new BidderBankAccountAlreadyVerifiedError();

    const now = formatUtcNow();
    await db
      .update(bidderBankAccounts)
      .set({
        isVerified: false,
        reviewedAt: now,
        reviewedBy: userId,
        updatedAt: now,
        updatedBy: userId,
      })
      .where(eq(bidderBankAccounts.bidderId, bidderId));

    const result = await this.getByBidderId(bidderId);
    if (!result) throw new BidderBankAccountNotFoundError();
    return result;
  }

  /**
   * Mark live profile unverified when the bidder opens an update request.
   * No-op if there is no live row yet.
   */
  async markUnverifiedForPendingUpdate(
    bidderId: number,
    userId: number,
  ): Promise<void> {
    await biddersService.requireBidder(bidderId);

    const [existing] = await db
      .select({ id: bidderBankAccounts.id })
      .from(bidderBankAccounts)
      .where(eq(bidderBankAccounts.bidderId, bidderId))
      .limit(1);

    if (!existing) return;

    const now = formatUtcNow();
    await db
      .update(bidderBankAccounts)
      .set({
        isVerified: false,
        updatedAt: now,
        updatedBy: userId,
      })
      .where(eq(bidderBankAccounts.bidderId, bidderId));
  }

  /**
   * Apply approved log fields onto the live row and mark verified.
   * Unlike `verify()`, this works even when the live row was already verified.
   */
  async applyVerifiedDetails(
    bidderId: number,
    input: UpsertBidderBankAccountInput,
    userId: number,
  ): Promise<BidderBankAccountView> {
    await this.upsert(bidderId, input, userId);

    const now = formatUtcNow();
    await db
      .update(bidderBankAccounts)
      .set({
        isVerified: true,
        reviewedAt: now,
        reviewedBy: userId,
        updatedAt: now,
        updatedBy: userId,
      })
      .where(eq(bidderBankAccounts.bidderId, bidderId));

    const result = await this.getByBidderId(bidderId);
    if (!result) throw new BidderBankAccountNotFoundError();
    return result;
  }
}

export const bidderBankAccountsService = new BidderBankAccountsService();
