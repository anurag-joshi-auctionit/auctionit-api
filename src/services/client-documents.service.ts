import { and, asc, count, desc, eq, ilike, max, or } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  CLIENT_DOCUMENT_TYPE_TNC,
  clientDocumentTypes,
} from "../db/schema/client-document-types.js";
import { clientDocumentLogs } from "../db/schema/client-document-logs.js";
import { users } from "../db/schema/users.js";
import type { ClientDocumentsListParams } from "../lib/clients/schemas.js";
import { uploadNewClientDocumentBytesToR2 } from "../lib/client-document-upload.js";
import {
  assertAuctionDocumentFile,
  AUCTION_DOCUMENT_ALLOWED_EXTENSIONS,
  MAX_AUCTION_DOCUMENT_BYTES,
} from "../lib/auction-r2-keys.js";
import {
  CLIENT_DOCUMENT_ALLOWED_EXTENSIONS,
  isAllowedClientDocumentExtension,
} from "../lib/client-r2-keys.js";
import { getSignedDownloadUrl } from "../lib/r2.js";
import { clientsService } from "./clients.service.js";
import { clampPagination } from "./list-query.js";
import { formatUtcNow } from "@auctionit/lib/date";

export const MAX_CLIENT_DOCUMENT_BYTES = 10 * 1024 * 1024;

export class ClientDocumentTypeNotFoundError extends Error {
  constructor() {
    super("DOCUMENT_TYPE_NOT_FOUND");
    this.name = "ClientDocumentTypeNotFoundError";
  }
}

export class ClientDocumentFileInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientDocumentFileInvalidError";
  }
}

export type ClientDocumentTypeOption = {
  documentTypeId: number;
  name: string;
  fileNamePrefix: string;
  allowedExtensions: string[];
  maxBytes: number;
};

export type ClientDocumentView = {
  id: number;
  documentTypeId: number;
  documentTypeName: string;
  fileName: string | null;
  previewUrl: string | null;
  createdAt: string | null;
  createdBy: number | null;
  createdByName: string | null;
};

export type ClientDocumentStorageRef = {
  id: number;
  fileName: string | null;
  s3Key: string;
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
  id: clientDocumentLogs.id,
  documentTypeId: clientDocumentLogs.documentTypeId,
  documentTypeName: clientDocumentTypes.name,
  fileName: clientDocumentLogs.fileName,
  s3Key: clientDocumentLogs.s3Key,
  createdAt: clientDocumentLogs.createdAt,
  createdBy: clientDocumentLogs.createdBy,
  createdByName: users.name,
};

function activeLogForClient(clientId: number) {
  return and(
    eq(clientDocumentLogs.clientId, clientId),
    eq(clientDocumentLogs.isActive, true),
  );
}

function constraintsForDocumentType(documentTypeId: number): {
  allowedExtensions: string[];
  maxBytes: number;
} {
  if (documentTypeId === CLIENT_DOCUMENT_TYPE_TNC) {
    return {
      allowedExtensions: [...AUCTION_DOCUMENT_ALLOWED_EXTENSIONS],
      maxBytes: MAX_AUCTION_DOCUMENT_BYTES,
    };
  }
  return {
    allowedExtensions: [...CLIENT_DOCUMENT_ALLOWED_EXTENSIONS],
    maxBytes: MAX_CLIENT_DOCUMENT_BYTES,
  };
}

export async function listActiveClientDocumentTypes(): Promise<
  ClientDocumentTypeOption[]
> {
  const rows = await db
    .select({
      documentTypeId: clientDocumentTypes.id,
      name: clientDocumentTypes.name,
      fileNamePrefix: clientDocumentTypes.fileNamePrefix,
    })
    .from(clientDocumentTypes)
    .where(eq(clientDocumentTypes.isActive, true))
    .orderBy(asc(clientDocumentTypes.id));

  return rows.map((row) => ({
    ...row,
    ...constraintsForDocumentType(row.documentTypeId),
  }));
}

export function listClientDocumentAllowedExtensions(): string[] {
  return [...CLIENT_DOCUMENT_ALLOWED_EXTENSIONS];
}

async function mapDocumentRowToView(
  row: DocumentLogRow,
): Promise<ClientDocumentView> {
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

export type ClientDocumentListResult = {
  items: ClientDocumentView[];
  total: number;
  page: number;
  pageSize: number;
};

function documentSearchCondition(search: string) {
  const term = `%${search}%`;
  return or(
    ilike(clientDocumentTypes.name, term),
    ilike(clientDocumentLogs.fileName, term),
    ilike(users.name, term),
  );
}

function documentOrderBy(
  sortBy: ClientDocumentsListParams["sortBy"],
  sortOrder: ClientDocumentsListParams["sortOrder"],
) {
  const descOrder = (sortOrder ?? "desc") === "desc";
  const col =
    sortBy === "fileName"
      ? clientDocumentLogs.fileName
      : sortBy === "documentTypeName"
        ? clientDocumentTypes.name
        : sortBy === "createdByName"
          ? users.name
          : clientDocumentLogs.createdAt;
  return descOrder
    ? [desc(col), desc(clientDocumentLogs.id)]
    : [asc(col), asc(clientDocumentLogs.id)];
}

export async function listClientDocuments(
  clientId: number,
  opts: ClientDocumentsListParams = { page: 1, pageSize: 10 },
): Promise<ClientDocumentListResult> {
  await clientsService.requireClient(clientId);

  const search = opts.search?.trim();
  const { page, pageSize, offset } = clampPagination(opts.page, opts.pageSize);

  const latestRows = await db
    .selectDistinctOn([clientDocumentLogs.documentTypeId], documentLogSelect)
    .from(clientDocumentLogs)
    .innerJoin(
      clientDocumentTypes,
      eq(clientDocumentLogs.documentTypeId, clientDocumentTypes.id),
    )
    .leftJoin(users, eq(clientDocumentLogs.createdBy, users.id))
    .where(activeLogForClient(clientId))
    .orderBy(
      clientDocumentLogs.documentTypeId,
      desc(clientDocumentLogs.createdAt),
      desc(clientDocumentLogs.id),
    );

  let filtered = latestRows;
  if (search) {
    const lower = search.toLowerCase();
    filtered = latestRows.filter((row) =>
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

  const total = filtered.length;
  const pageRows = filtered.slice(offset, offset + pageSize);

  return {
    items: await Promise.all(pageRows.map((row) => mapDocumentRowToView(row))),
    total,
    page,
    pageSize,
  };
}

export async function listClientDocumentHistory(
  clientId: number,
  opts: ClientDocumentsListParams = { page: 1, pageSize: 10 },
): Promise<ClientDocumentListResult> {
  await clientsService.requireClient(clientId);

  const search = opts.search?.trim();
  const { page, pageSize, offset } = clampPagination(opts.page, opts.pageSize);

  const conditions = [activeLogForClient(clientId)];
  if (search) {
    conditions.push(documentSearchCondition(search)!);
  }
  const whereExpr = and(...conditions);
  const orderBy = documentOrderBy(opts.sortBy, opts.sortOrder);

  const [rows, [countRow]] = await Promise.all([
    db
      .select(documentLogSelect)
      .from(clientDocumentLogs)
      .innerJoin(
        clientDocumentTypes,
        eq(clientDocumentLogs.documentTypeId, clientDocumentTypes.id),
      )
      .leftJoin(users, eq(clientDocumentLogs.createdBy, users.id))
      .where(whereExpr)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset(offset),
    db
      .select({ total: count() })
      .from(clientDocumentLogs)
      .innerJoin(
        clientDocumentTypes,
        eq(clientDocumentLogs.documentTypeId, clientDocumentTypes.id),
      )
      .leftJoin(users, eq(clientDocumentLogs.createdBy, users.id))
      .where(whereExpr),
  ]);

  return {
    items: await Promise.all(rows.map((row) => mapDocumentRowToView(row))),
    total: Number(countRow?.total ?? 0),
    page,
    pageSize,
  };
}

export async function getLatestClientDocumentView(
  clientId: number,
  documentTypeId: number,
): Promise<ClientDocumentView | null> {
  const [row] = await db
    .select(documentLogSelect)
    .from(clientDocumentLogs)
    .innerJoin(
      clientDocumentTypes,
      eq(clientDocumentLogs.documentTypeId, clientDocumentTypes.id),
    )
    .leftJoin(users, eq(clientDocumentLogs.createdBy, users.id))
    .where(
      and(
        eq(clientDocumentLogs.clientId, clientId),
        eq(clientDocumentLogs.documentTypeId, documentTypeId),
        eq(clientDocumentLogs.isActive, true),
      ),
    )
    .orderBy(desc(clientDocumentLogs.createdAt), desc(clientDocumentLogs.id))
    .limit(1);

  if (!row) return null;
  return mapDocumentRowToView(row);
}

/** Latest active document storage ref (includes s3Key) for server-side copy. */
export async function getLatestClientDocumentStorageRef(
  clientId: number,
  documentTypeId: number,
): Promise<ClientDocumentStorageRef | null> {
  const [row] = await db
    .select({
      id: clientDocumentLogs.id,
      fileName: clientDocumentLogs.fileName,
      s3Key: clientDocumentLogs.s3Key,
    })
    .from(clientDocumentLogs)
    .where(
      and(
        eq(clientDocumentLogs.clientId, clientId),
        eq(clientDocumentLogs.documentTypeId, documentTypeId),
        eq(clientDocumentLogs.isActive, true),
      ),
    )
    .orderBy(desc(clientDocumentLogs.createdAt), desc(clientDocumentLogs.id))
    .limit(1);

  if (!row?.s3Key) return null;
  return {
    id: row.id,
    fileName: row.fileName,
    s3Key: row.s3Key,
  };
}

async function nextDocumentLogId(): Promise<number> {
  const [row] = await db
    .select({ value: max(clientDocumentLogs.id) })
    .from(clientDocumentLogs);
  return (row?.value ?? 0) + 1;
}

export async function uploadClientFileToR2(opts: {
  buffer: Buffer;
  userId: number;
  prefix: string;
  clientId: number;
  originalFileName: string;
  at?: Date;
}): Promise<{
  filename: string;
  s3Key: string;
  storageFileName: string;
}> {
  const uploaded = await uploadNewClientDocumentBytesToR2({
    buffer: opts.buffer,
    prefix: opts.prefix,
    clientId: opts.clientId,
    originalFileName: opts.originalFileName,
    at: opts.at,
  });

  return {
    filename: uploaded.filename,
    s3Key: uploaded.s3Key,
    storageFileName: uploaded.storageFileName,
  };
}

export async function insertClientDocumentLog(opts: {
  clientId: number;
  documentTypeId: number;
  s3Key: string;
  storageFileName: string;
  userId: number;
  createdAt?: string;
}): Promise<void> {
  const createdAt = opts.createdAt ?? formatUtcNow();
  const documentId = await nextDocumentLogId();

  await db.insert(clientDocumentLogs).values({
    id: documentId,
    clientId: opts.clientId,
    documentTypeId: opts.documentTypeId,
    fileName: opts.storageFileName,
    s3Key: opts.s3Key,
    isActive: true,
    createdAt,
    createdBy: opts.userId,
  });
}

async function requireActiveDocumentType(
  documentTypeId: number,
): Promise<ClientDocumentTypeOption> {
  const [row] = await db
    .select({
      documentTypeId: clientDocumentTypes.id,
      name: clientDocumentTypes.name,
      fileNamePrefix: clientDocumentTypes.fileNamePrefix,
    })
    .from(clientDocumentTypes)
    .where(
      and(
        eq(clientDocumentTypes.id, documentTypeId),
        eq(clientDocumentTypes.isActive, true),
      ),
    );

  if (!row) throw new ClientDocumentTypeNotFoundError();
  return {
    ...row,
    ...constraintsForDocumentType(row.documentTypeId),
  };
}

export async function uploadClientDocument(opts: {
  clientId: number;
  documentTypeId: number;
  buffer: Buffer;
  originalFileName: string;
  userId: number;
}): Promise<ClientDocumentView> {
  await clientsService.requireClient(opts.clientId);

  const docType = await requireActiveDocumentType(opts.documentTypeId);
  const constraints = constraintsForDocumentType(opts.documentTypeId);

  if (opts.documentTypeId === CLIENT_DOCUMENT_TYPE_TNC) {
    try {
      assertAuctionDocumentFile(opts.originalFileName, opts.buffer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (
        msg.includes("too large") ||
        msg.toLowerCase().includes("empty") ||
        opts.buffer.length === 0 ||
        opts.buffer.length > constraints.maxBytes
      ) {
        throw new ClientDocumentFileInvalidError("TNC_INVALID_SIZE");
      }
      throw new ClientDocumentFileInvalidError("TNC_INVALID_EXTENSION");
    }
  } else {
    if (
      !opts.originalFileName.trim() ||
      !isAllowedClientDocumentExtension(opts.originalFileName)
    ) {
      throw new ClientDocumentFileInvalidError("INVALID_EXTENSION");
    }

    if (
      opts.buffer.length === 0 ||
      opts.buffer.length > MAX_CLIENT_DOCUMENT_BYTES
    ) {
      throw new ClientDocumentFileInvalidError("INVALID_SIZE");
    }
  }

  const at = new Date();

  const uploaded = await uploadClientFileToR2({
    buffer: opts.buffer,
    userId: opts.userId,
    prefix: docType.fileNamePrefix,
    clientId: opts.clientId,
    originalFileName: opts.originalFileName,
    at,
  });

  await insertClientDocumentLog({
    clientId: opts.clientId,
    documentTypeId: opts.documentTypeId,
    s3Key: uploaded.s3Key,
    storageFileName: uploaded.storageFileName,
    userId: opts.userId,
    createdAt: formatUtcNow(at),
  });

  const view = await getLatestClientDocumentView(
    opts.clientId,
    opts.documentTypeId,
  );
  if (!view) {
    throw new Error("CLIENT_DOCUMENT_INSERT_FAILED");
  }
  return view;
}
