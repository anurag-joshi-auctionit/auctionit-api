import { and, asc, count, desc, eq, ilike, max, ne, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { bidderBankAccounts } from "../db/schema/bidder-bank-accounts.js";
import { bidderDocumentTypes } from "../db/schema/bidder-document-types.js";
import { bidderDocumentLogs } from "../db/schema/bidder-document-logs.js";
import { users } from "../db/schema/users.js";
import type { BidderDocumentsListParams } from "../lib/bidders/schemas.js";
import {
  BIDDER_DOCUMENT_TYPE_CANCELLED_CHEQUE,
  buildNewBidderDocumentFileName,
  legacyBidderDocumentTypePrefix,
} from "../lib/bidder-document-naming.js";
import { uploadNewBidderDocumentBytesToR2 } from "../lib/bidder-document-upload.js";
import {
  BIDDER_DOCUMENT_ALLOWED_EXTENSIONS,
  isAllowedBidderDocumentExtension,
} from "../lib/bidder-r2-keys.js";
import { getSignedDownloadUrl } from "../lib/r2.js";
import { biddersService } from "./bidders.service.js";
import { clampPagination } from "./list-query.js";
import { formatUtcNow } from "@auctionit/lib/date";

export const MAX_BIDDER_DOCUMENT_BYTES = 10 * 1024 * 1024;

export class BidderDocumentTypeNotFoundError extends Error {
  constructor() {
    super("DOCUMENT_TYPE_NOT_FOUND");
    this.name = "BidderDocumentTypeNotFoundError";
  }
}

export class BidderDocumentFileInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BidderDocumentFileInvalidError";
  }
}

export type BidderDocumentTypeOption = {
  documentTypeId: number;
  name: string;
  fileNamePrefix: string;
};

export type BidderDocumentView = {
  id: number;
  documentTypeId: number;
  documentTypeName: string;
  fileName: string | null;
  previewUrl: string | null;
  createdAt: string | null;
  createdBy: number | null;
  createdByName: string | null;
};

type DocumentLogRow = {
  id: number;
  documentTypeId: number;
  documentTypeName: string;
  fileName: string | null;
  s3Key: string | null;
  createdAt: string | null;
  createdBy: number | null;
  createdByName: string | null;
};

const documentLogSelect = {
  id: bidderDocumentLogs.id,
  documentTypeId: bidderDocumentLogs.documentTypeId,
  documentTypeName: bidderDocumentTypes.name,
  fileName: bidderDocumentLogs.fileName,
  s3Key: bidderDocumentLogs.s3Key,
  createdAt: bidderDocumentLogs.createdAt,
  createdBy: bidderDocumentLogs.createdBy,
  createdByName: users.name,
};

function activeLogForBidder(bidderId: number) {
  return and(
    eq(bidderDocumentLogs.bidderId, bidderId),
    eq(bidderDocumentLogs.isActive, true),
  );
}

export async function listActiveBidderDocumentTypes(): Promise<
  BidderDocumentTypeOption[]
> {
  return db
    .select({
      documentTypeId: bidderDocumentTypes.id,
      name: bidderDocumentTypes.name,
      fileNamePrefix: bidderDocumentTypes.fileNamePrefix,
    })
    .from(bidderDocumentTypes)
    .where(
      and(
        eq(bidderDocumentTypes.isActive, true),
        // Cancelled cheque is uploaded via bank-account update, not Documents.
        ne(
          bidderDocumentTypes.id,
          BIDDER_DOCUMENT_TYPE_CANCELLED_CHEQUE,
        ),
      ),
    )
    .orderBy(asc(bidderDocumentTypes.id));
}

export function listBidderDocumentAllowedExtensions(): string[] {
  return [...BIDDER_DOCUMENT_ALLOWED_EXTENSIONS];
}

async function mapDocumentRowToView(
  row: DocumentLogRow,
): Promise<BidderDocumentView> {
  const fileName = row.fileName?.trim() || null;
  const previewUrl = row.s3Key ? await getSignedDownloadUrl(row.s3Key) : null;

  return {
    id: row.id,
    documentTypeId: row.documentTypeId,
    documentTypeName: row.documentTypeName,
    fileName,
    previewUrl,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    createdByName: row.createdByName,
  };
}

export type BidderDocumentListResult = {
  items: BidderDocumentView[];
  total: number;
  page: number;
  pageSize: number;
};

function documentSearchCondition(search: string) {
  const term = `%${search}%`;
  return or(
    ilike(bidderDocumentTypes.name, term),
    ilike(bidderDocumentLogs.fileName, term),
    ilike(users.name, term),
  );
}

function documentOrderBy(
  sortBy: BidderDocumentsListParams["sortBy"],
  sortOrder: BidderDocumentsListParams["sortOrder"],
) {
  const descOrder = (sortOrder ?? "desc") === "desc";
  const col =
    sortBy === "fileName"
      ? bidderDocumentLogs.fileName
      : sortBy === "documentTypeName"
        ? bidderDocumentTypes.name
        : sortBy === "createdByName"
          ? users.name
          : bidderDocumentLogs.createdAt;
  return descOrder
    ? [desc(col), desc(bidderDocumentLogs.id)]
    : [asc(col), asc(bidderDocumentLogs.id)];
}

function filterSortPageDocumentRows(
  rows: DocumentLogRow[],
  opts: BidderDocumentsListParams,
) {
  const search = opts.search?.trim();
  const { page, pageSize, offset } = clampPagination(opts.page, opts.pageSize);

  let filtered = rows;
  if (search) {
    const lower = search.toLowerCase();
    filtered = rows.filter((row) =>
      [row.documentTypeName, row.fileName, row.createdByName]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(lower)),
    );
  }

  const sortBy = opts.sortBy ?? "createdAt";
  const descOrder = (opts.sortOrder ?? "desc") === "desc";
  filtered = [...filtered].sort((a, b) => {
    const av =
      sortBy === "fileName"
        ? a.fileName
        : sortBy === "documentTypeName"
          ? a.documentTypeName
          : sortBy === "createdByName"
            ? a.createdByName
            : a.createdAt;
    const bv =
      sortBy === "fileName"
        ? b.fileName
        : sortBy === "documentTypeName"
          ? b.documentTypeName
          : sortBy === "createdByName"
            ? b.createdByName
            : b.createdAt;
    const aStr = av ?? "";
    const bStr = bv ?? "";
    const cmp = aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
    return descOrder ? -cmp : cmp;
  });

  return {
    pageRows: filtered.slice(offset, offset + pageSize),
    total: filtered.length,
    page,
    pageSize,
  };
}

export async function listBidderDocuments(
  bidderId: number,
  opts: BidderDocumentsListParams = { page: 1, pageSize: 10 },
): Promise<BidderDocumentListResult> {
  await biddersService.requireBidder(bidderId);

  const latestRows = await db
    .selectDistinctOn([bidderDocumentLogs.documentTypeId], documentLogSelect)
    .from(bidderDocumentLogs)
    .innerJoin(
      bidderDocumentTypes,
      eq(bidderDocumentLogs.documentTypeId, bidderDocumentTypes.id),
    )
    .leftJoin(users, eq(bidderDocumentLogs.createdBy, users.id))
    .where(activeLogForBidder(bidderId))
    .orderBy(
      bidderDocumentLogs.documentTypeId,
      desc(bidderDocumentLogs.createdAt),
      desc(bidderDocumentLogs.id),
    );

  const { pageRows, total, page, pageSize } = filterSortPageDocumentRows(
    latestRows,
    opts,
  );

  return {
    items: await Promise.all(pageRows.map((row) => mapDocumentRowToView(row))),
    total,
    page,
    pageSize,
  };
}

export async function listBidderDocumentHistory(
  bidderId: number,
  opts: BidderDocumentsListParams = { page: 1, pageSize: 10 },
): Promise<BidderDocumentListResult> {
  await biddersService.requireBidder(bidderId);

  const search = opts.search?.trim();
  const { page, pageSize, offset } = clampPagination(opts.page, opts.pageSize);

  const conditions = [activeLogForBidder(bidderId)];
  if (search) {
    conditions.push(documentSearchCondition(search)!);
  }
  const whereExpr = and(...conditions);
  const orderBy = documentOrderBy(opts.sortBy, opts.sortOrder);

  const [rows, [countRow]] = await Promise.all([
    db
      .select(documentLogSelect)
      .from(bidderDocumentLogs)
      .innerJoin(
        bidderDocumentTypes,
        eq(bidderDocumentLogs.documentTypeId, bidderDocumentTypes.id),
      )
      .leftJoin(users, eq(bidderDocumentLogs.createdBy, users.id))
      .where(whereExpr)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset(offset),
    db
      .select({ total: count() })
      .from(bidderDocumentLogs)
      .innerJoin(
        bidderDocumentTypes,
        eq(bidderDocumentLogs.documentTypeId, bidderDocumentTypes.id),
      )
      .leftJoin(users, eq(bidderDocumentLogs.createdBy, users.id))
      .where(whereExpr),
  ]);

  return {
    items: await Promise.all(rows.map((row) => mapDocumentRowToView(row))),
    total: Number(countRow?.total ?? 0),
    page,
    pageSize,
  };
}

export async function getLatestBidderDocumentView(
  bidderId: number,
  documentTypeId: number,
): Promise<BidderDocumentView | null> {
  const [row] = await db
    .select(documentLogSelect)
    .from(bidderDocumentLogs)
    .innerJoin(
      bidderDocumentTypes,
      eq(bidderDocumentLogs.documentTypeId, bidderDocumentTypes.id),
    )
    .leftJoin(users, eq(bidderDocumentLogs.createdBy, users.id))
    .where(
      and(
        eq(bidderDocumentLogs.bidderId, bidderId),
        eq(bidderDocumentLogs.documentTypeId, documentTypeId),
        eq(bidderDocumentLogs.isActive, true),
      ),
    )
    .orderBy(desc(bidderDocumentLogs.createdAt), desc(bidderDocumentLogs.id))
    .limit(1);

  if (!row) return null;
  return mapDocumentRowToView(row);
}

export async function getCancelledChequeSignedUrl(
  bidderId: number,
): Promise<string | null> {
  const [row] = await db
    .select({ s3Key: bidderDocumentLogs.s3Key })
    .from(bidderDocumentLogs)
    .where(
      and(
        eq(bidderDocumentLogs.bidderId, bidderId),
        eq(
          bidderDocumentLogs.documentTypeId,
          BIDDER_DOCUMENT_TYPE_CANCELLED_CHEQUE,
        ),
        eq(bidderDocumentLogs.isActive, true),
      ),
    )
    .orderBy(desc(bidderDocumentLogs.createdAt), desc(bidderDocumentLogs.id))
    .limit(1);

  if (!row?.s3Key) return null;
  return getSignedDownloadUrl(row.s3Key);
}

async function nextDocumentLogId(): Promise<number> {
  const [row] = await db
    .select({ value: max(bidderDocumentLogs.id) })
    .from(bidderDocumentLogs);
  return (row?.value ?? 0) + 1;
}

export async function uploadBidderFileToR2(opts: {
  buffer: Buffer;
  userId: number;
  prefix: string;
  bidderId: number;
  originalFileName: string;
  at?: Date;
}): Promise<{
  filename: string;
  s3Key: string;
  storageFileName: string;
}> {
  const uploaded = await uploadNewBidderDocumentBytesToR2({
    buffer: opts.buffer,
    prefix: opts.prefix,
    bidderId: opts.bidderId,
    originalFileName: opts.originalFileName,
    at: opts.at,
  });

  return {
    filename: uploaded.filename,
    s3Key: uploaded.s3Key,
    storageFileName: uploaded.storageFileName,
  };
}

export async function insertBidderDocumentLog(opts: {
  bidderId: number;
  documentTypeId: number;
  s3Key: string;
  storageFileName: string;
  userId: number;
  createdAt?: string;
}): Promise<void> {
  const createdAt = opts.createdAt ?? formatUtcNow();
  const documentId = await nextDocumentLogId();

  await db.insert(bidderDocumentLogs).values({
    id: documentId,
    bidderId: opts.bidderId,
    documentTypeId: opts.documentTypeId,
    fileName: opts.storageFileName,
    s3Key: opts.s3Key,
    isActive: true,
    createdAt,
    createdBy: opts.userId,
  });

  if (opts.documentTypeId === BIDDER_DOCUMENT_TYPE_CANCELLED_CHEQUE) {
    await db
      .update(bidderBankAccounts)
      .set({
        cancelledChequeFileName: opts.storageFileName,
        updatedAt: createdAt,
        updatedBy: opts.userId,
      })
      .where(eq(bidderBankAccounts.bidderId, opts.bidderId));
  }
}

export async function insertCancelledChequeDocumentLog(opts: {
  bidderId: number;
  s3Key: string;
  storageFileName: string;
  userId: number;
  createdAt?: string;
}): Promise<void> {
  await insertBidderDocumentLog({
    bidderId: opts.bidderId,
    documentTypeId: BIDDER_DOCUMENT_TYPE_CANCELLED_CHEQUE,
    s3Key: opts.s3Key,
    storageFileName: opts.storageFileName,
    userId: opts.userId,
    createdAt: opts.createdAt,
  });
}

async function requireActiveDocumentType(
  documentTypeId: number,
): Promise<BidderDocumentTypeOption> {
  const [row] = await db
    .select({
      documentTypeId: bidderDocumentTypes.id,
      name: bidderDocumentTypes.name,
      fileNamePrefix: bidderDocumentTypes.fileNamePrefix,
    })
    .from(bidderDocumentTypes)
    .where(
      and(
        eq(bidderDocumentTypes.id, documentTypeId),
        eq(bidderDocumentTypes.isActive, true),
      ),
    );

  if (!row) throw new BidderDocumentTypeNotFoundError();
  return row;
}

export async function uploadBidderDocument(opts: {
  bidderId: number;
  documentTypeId: number;
  buffer: Buffer;
  originalFileName: string;
  userId: number;
}): Promise<BidderDocumentView> {
  await biddersService.requireBidder(opts.bidderId);

  // Cancelled cheque is uploaded via bank-account update, not Documents.
  if (opts.documentTypeId === BIDDER_DOCUMENT_TYPE_CANCELLED_CHEQUE) {
    throw new BidderDocumentTypeNotFoundError();
  }

  if (
    !opts.originalFileName.trim() ||
    !isAllowedBidderDocumentExtension(opts.originalFileName)
  ) {
    throw new BidderDocumentFileInvalidError("INVALID_EXTENSION");
  }

  if (
    opts.buffer.length === 0 ||
    opts.buffer.length > MAX_BIDDER_DOCUMENT_BYTES
  ) {
    throw new BidderDocumentFileInvalidError("INVALID_SIZE");
  }

  const docType = await requireActiveDocumentType(opts.documentTypeId);
  const at = new Date();

  const uploaded = await uploadBidderFileToR2({
    buffer: opts.buffer,
    userId: opts.userId,
    prefix: docType.fileNamePrefix,
    bidderId: opts.bidderId,
    originalFileName: opts.originalFileName,
    at,
  });

  await insertBidderDocumentLog({
    bidderId: opts.bidderId,
    documentTypeId: opts.documentTypeId,
    s3Key: uploaded.s3Key,
    storageFileName: uploaded.storageFileName,
    userId: opts.userId,
    createdAt: formatUtcNow(at),
  });

  const view = await getLatestBidderDocumentView(
    opts.bidderId,
    opts.documentTypeId,
  );
  if (!view) {
    throw new Error("BIDDER_DOCUMENT_INSERT_FAILED");
  }
  return view;
}

export function buildCancelledChequeStorageFileName(opts: {
  bidderId: number;
  originalFilename?: string;
  at?: Date;
}): string {
  return buildNewBidderDocumentFileName({
    prefix: legacyBidderDocumentTypePrefix(
      BIDDER_DOCUMENT_TYPE_CANCELLED_CHEQUE,
    ),
    bidderId: opts.bidderId,
    originalFileName: opts.originalFilename ?? "cheque.jpg",
    at: opts.at,
  });
}
