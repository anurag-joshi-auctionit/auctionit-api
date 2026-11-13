import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, ilike, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { files } from "../db/schema/index.js";
import { getSignedDownloadUrl, putObject } from "../lib/r2.js";
import { clampPagination } from "./list-query.js";

export type FileListItem = {
  id: number;
  filename: string;
  s3Key: string;
  /** Signed download URL — set for uploads; omit on list to avoid per-row signing. */
  url?: string;
  createdAt: string;
};

export type FilesListParams = {
  page: number;
  pageSize: number;
  search?: string;
  sortBy?: "createdAt" | "filename";
  sortOrder?: "asc" | "desc";
};

export type FilesListResult = {
  items: FileListItem[];
  total: number;
  page: number;
  pageSize: number;
};

/** Common, low-risk file extensions accepted for upload (lowercase, no dot). */
export const ALLOWED_FILE_EXTENSIONS = [
  // documents
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "txt",
  "csv",
  // images
  "jpg",
  "jpeg",
  "png",
  "webp",
  "svg",
  // archives
  "zip",
] as const;

export function getFileExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx < 0 || idx === filename.length - 1) return "";
  return filename.slice(idx + 1).toLowerCase();
}

export function isAllowedExtension(filename: string): boolean {
  const ext = getFileExtension(filename);
  return (ALLOWED_FILE_EXTENSIONS as readonly string[]).includes(ext);
}

function buildKey(userId: number, filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-100);
  return `users/${userId}/${randomUUID()}-${safe}`;
}

export class FilesService {
  async upload(input: {
    userId: number;
    filename: string;
    contentType?: string;
    body: Buffer;
  }): Promise<FileListItem> {
    const key = buildKey(input.userId, input.filename);
    await putObject({ key, body: input.body, contentType: input.contentType });

    const [row] = await db
      .insert(files)
      .values({
        filename: input.filename,
        s3Key: key,
        uploadedBy: input.userId,
      })
      .returning();

    const url = await getSignedDownloadUrl(row!.s3Key);
    return {
      id: row!.id,
      filename: row!.filename,
      s3Key: row!.s3Key,
      url,
      createdAt: row!.createdAt,
    };
  }

  async listForUser(
    userId: number,
    opts: FilesListParams = { page: 1, pageSize: 10 },
  ): Promise<FilesListResult> {
    const { page, pageSize, offset } = clampPagination(opts.page, opts.pageSize);
    const search = opts.search?.trim();
    const conditions: SQL[] = [eq(files.uploadedBy, userId)];
    if (search) {
      conditions.push(ilike(files.filename, `%${search}%`));
    }
    const whereExpr = and(...conditions);
    const descOrder = (opts.sortOrder ?? "desc") === "desc";
    const sortBy = opts.sortBy ?? "createdAt";
    const primaryCol =
      sortBy === "filename" ? files.filename : files.createdAt;
    const orderBy = descOrder
      ? [desc(primaryCol), desc(files.id)]
      : [asc(primaryCol), asc(files.id)];

    const [rows, [countRow]] = await Promise.all([
      db
        .select({
          id: files.id,
          filename: files.filename,
          s3Key: files.s3Key,
          createdAt: files.createdAt,
        })
        .from(files)
        .where(whereExpr)
        .orderBy(...orderBy)
        .limit(pageSize)
        .offset(offset),
      db.select({ total: count() }).from(files).where(whereExpr),
    ]);

    return {
      items: rows.map((r) => ({
        id: r.id,
        filename: r.filename,
        s3Key: r.s3Key,
        createdAt: r.createdAt,
      })),
      total: Number(countRow?.total ?? 0),
      page,
      pageSize,
    };
  }

  async getSignedUrlForUser(
    userId: number,
    fileId: number,
  ): Promise<string | null> {
    const [row] = await db
      .select({ s3Key: files.s3Key })
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.uploadedBy, userId)))
      .limit(1);
    if (!row) return null;
    return getSignedDownloadUrl(row.s3Key);
  }
}

export const filesService = new FilesService();
