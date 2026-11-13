import { and, asc, desc, eq, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import {
  ServiceInvoicesErrorMessages,
  ServiceInvoicesValidationMessages,
} from "@auctionit/messages/service-invoices";
import {
  serviceInvoiceRequiresAnnexurePdf,
  type ServiceFeeType,
} from "@auctionit/messages/clients";
import { computeFeeTotals } from "../lib/service-invoices/fee-calc.js";
import { aggregateAnnexureTotals } from "../lib/service-invoices/annexure-totals.js";
import { parseServiceInvoiceAnnexureBuffer } from "../lib/service-invoices/annexure-parse.js";
import {
  buildAnnexurePdf,
  type AnnexurePdfInput,
} from "../lib/service-invoices/annexure-pdf.js";
import {
  persistServiceInvoiceAnnexure,
  persistServiceInvoicePdf,
  readServiceInvoiceAnnexureBuffer,
  signedServiceInvoiceAnnexureUrl,
} from "../lib/service-invoices/annexure-r2.js";
import { SI_PDF_CONTENT_TYPE } from "../lib/service-invoices/annexure-r2-keys.js";
import {
  buildServiceInvoiceEmailHtml,
  buildServiceInvoiceEmailSubject,
  SERVICE_INVOICE_EMAIL_BCC,
  SERVICE_INVOICE_EMAIL_CC,
} from "../lib/service-invoices/service-invoice-email-template.js";
import { formatCurrency } from "@auctionit/lib/currency";
import { formatDate, formatMonthYearShort, formatUtcNow } from "@auctionit/lib/date";
import {
  SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_PDF,
  SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_XLSX,
  SERVICE_INVOICE_DOCUMENT_TYPE_INVOICE_PDF,
} from "../lib/service-invoices/service-invoice-document-naming.js";
import { buildServiceInvoiceAnnexureXlsxFromLines } from "../lib/service-invoices/annexure-template.js";
import type { ServiceInvoiceAnnexureLine } from "../lib/service-invoices/annexure-types.js";
import type {
  AccountsServiceInvoiceActionInput,
  CreateServiceInvoiceInput,
  PatchServiceInvoiceInput,
  ServiceInvoicesExportParams,
  ServiceInvoicesListParams,
} from "../lib/service-invoices/schemas.js";
import {
  SERVICE_INVOICE_EXPORT_MAX_ROWS,
  SERVICE_INVOICE_EXPORT_PAGE_SIZE,
} from "../lib/service-invoices/export-constants.js";
import { statusStampFields } from "../lib/service-invoices/status-stamps.js";
import {
  ACCOUNTS_FIELD_EDITABLE_STATUSES,
  ACCOUNTS_PDF_UPLOAD_STATUSES,
  ACCOUNTS_STATUS_TRANSITIONS,
  isAdminEditableStatus,
  isCancelledStatus,
} from "../lib/service-invoices/status-rules.js";
import { db } from "../db/index.js";
import { clients } from "../db/schema/clients.js";
import { plantLocations } from "../db/schema/plant-locations.js";
import { serviceInvoiceDocuments } from "../db/schema/service-invoice-documents.js";
import {
  serviceInvoices,
  type ServiceInvoicePaymentStatus,
  type ServiceInvoiceStatus,
  type ServiceInvoiceType,
} from "../db/schema/service-invoices.js";
import { EMAIL_SOURCE_TYPE_SERVICE_INVOICE } from "../db/schema/notification-email-logs.js";
import { NOTIFICATION_TYPE_SERVICE_INVOICE_ANNEXURE } from "../db/schema/notification-types.js";
import { nextId } from "./_id.js";
import { clampPagination, combineConditions } from "./list-query.js";
import { fetchAutoAnnexureLines } from "./service-invoice-annexure.service.js";
import { enqueueEmails } from "./email-dispatch.service.js";

export type { ServiceInvoicesListParams } from "../lib/service-invoices/schemas.js";

export type ServiceInvoiceListRow = {
  id: number;
  clientId: number;
  clientName: string;
  plantLocationId: number;
  plantLocationName: string | null;
  fromDate: string;
  toDate: string;
  type: ServiceInvoiceType;
  orderNumber: string | null;
  orderDate: string | null;
  gracePeriod: number | null;
  totalQuantity: number;
  totalAmount: number;
  serviceFeeType: ServiceFeeType;
  serviceFeeValue: number;
  serviceFeeAmount: number;
  gstPercent: number;
  gstAmount: number;
  grandTotal: number;
  roundOff: number | null;
  serviceChargeDescription: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  paymentDueDate: string | null;
  paidAmount: number;
  unpaidAmount: number;
  latestPaymentDate: string | null;
  paymentStatus: ServiceInvoicePaymentStatus;
  annexureXlsxFilename: string | null;
  annexureXlsxS3Key: string | null;
  annexureXlsxUrl: string | null;
  annexurePdfFilename: string | null;
  annexurePdfS3Key: string | null;
  annexurePdfUrl: string | null;
  invoicePdfFilename: string | null;
  invoicePdfS3Key: string | null;
  invoicePdfUrl: string | null;
  hasAnnexure: boolean;
  status: ServiceInvoiceStatus;
  requestedAt: string | null;
  requestedBy: number | null;
  generatedAt: string | null;
  generatedBy: number | null;
  emailSentAt: string | null;
  emailSentBy: number | null;
  recheckedAt: string | null;
  recheckedBy: number | null;
  cancelledAt: string | null;
  cancelledBy: number | null;
  createdAt: string;
  updatedAt: string | null;
};

export type ServiceInvoiceListResult = {
  items: ServiceInvoiceListRow[];
  total: number;
  page: number;
  pageSize: number;
};

export class ServiceInvoiceNotFoundError extends Error {
  constructor() {
    super(ServiceInvoicesErrorMessages.NOT_FOUND);
    this.name = "ServiceInvoiceNotFoundError";
  }
}

export class ServiceInvoiceClientNotFoundError extends Error {
  constructor() {
    super(ServiceInvoicesErrorMessages.CLIENT_NOT_FOUND);
    this.name = "ServiceInvoiceClientNotFoundError";
  }
}

export class ServiceInvoicePlantNotFoundError extends Error {
  constructor() {
    super(ServiceInvoicesErrorMessages.PLANT_NOT_FOUND);
    this.name = "ServiceInvoicePlantNotFoundError";
  }
}

export class ServiceInvoiceLockedError extends Error {
  constructor() {
    super(ServiceInvoicesErrorMessages.LOCKED);
    this.name = "ServiceInvoiceLockedError";
  }
}

export class ServiceInvoiceAnnexureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceInvoiceAnnexureError";
  }
}

export class ServiceInvoiceForbiddenError extends Error {
  constructor() {
    super(ServiceInvoicesErrorMessages.FORBIDDEN);
    this.name = "ServiceInvoiceForbiddenError";
  }
}

export class ServiceInvoiceAccountsTransitionError extends Error {
  constructor(message?: string) {
    super(
      message ?? ServiceInvoicesValidationMessages.INVALID_ACCOUNTS_TRANSITION,
    );
    this.name = "ServiceInvoiceAccountsTransitionError";
  }
}

export class ServiceInvoiceValidationError extends Error {
  fieldErrors?: Record<string, string[]>;

  constructor(message: string, fieldErrors?: Record<string, string[]>) {
    super(message);
    this.name = "ServiceInvoiceValidationError";
    this.fieldErrors = fieldErrors;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}

function isServiceInvoiceNumberUniqueViolation(err: unknown): boolean {
  if (!isUniqueViolation(err)) return false;
  const constraint =
    typeof err === "object" &&
    err !== null &&
    "constraint" in err &&
    typeof (err as { constraint: unknown }).constraint === "string"
      ? (err as { constraint: string }).constraint
      : "";
  return (
    constraint.includes("service_invoices_invoice_number_uidx") ||
    constraint.includes("invoice_number")
  );
}

function duplicateServiceInvoiceNumberError(): ServiceInvoiceValidationError {
  const message = ServiceInvoicesValidationMessages.INVOICE_NUMBER_DUPLICATE;
  return new ServiceInvoiceValidationError(message, {
    invoiceNumber: [message],
  });
}

async function assertServiceInvoiceNumberAvailable(
  invoiceNumber: string,
  excludeId?: number,
): Promise<void> {
  if (!invoiceNumber) return;

  const conditions: SQL[] = [
    eq(serviceInvoices.invoiceNumber, invoiceNumber),
  ];
  if (excludeId != null) {
    conditions.push(ne(serviceInvoices.id, excludeId));
  }

  const rows = await db
    .select({ id: serviceInvoices.id })
    .from(serviceInvoices)
    .where(and(...conditions))
    .limit(1);

  if (rows[0]) {
    throw duplicateServiceInvoiceNumberError();
  }
}

export type ServiceInvoiceStats = {
  draft: number;
  requested: number;
  recheck: number;
  generated: number;
  cancelled: number;
  /** Non-draft invoices only (accounts Total card). */
  total: number;
};

export type ServiceInvoiceOutstandingStats = {
  count: number;
  amount: number;
};

function derivePaymentStatus(
  paidAmount: number,
  grandTotal: number,
): ServiceInvoicePaymentStatus {
  if (paidAmount <= 0) return "unpaid";
  if (paidAmount < grandTotal) return "partially_paid";
  return "paid";
}

const SORT_FIELDS = new Set([
  "id",
  "clientName",
  "fromDate",
  "toDate",
  "grandTotal",
  "status",
  "createdAt",
] as const);

function num(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toNumericString(n: number, scale: number): string {
  return n.toFixed(scale);
}

type DocFileRef = {
  fileName: string | null;
  s3Key: string | null;
};

type InvoiceDocs = {
  annexureXlsx: DocFileRef;
  annexurePdf: DocFileRef;
  invoicePdf: DocFileRef;
};

const EMPTY_DOC: DocFileRef = { fileName: null, s3Key: null };

function emptyInvoiceDocs(): InvoiceDocs {
  return {
    annexureXlsx: { ...EMPTY_DOC },
    annexurePdf: { ...EMPTY_DOC },
    invoicePdf: { ...EMPTY_DOC },
  };
}

/** Latest active log per (invoice, type) for the given invoice ids. */
async function docsByInvoiceIds(
  invoiceIds: number[],
): Promise<Map<number, InvoiceDocs>> {
  const result = new Map<number, InvoiceDocs>();
  for (const id of invoiceIds) {
    result.set(id, emptyInvoiceDocs());
  }
  if (invoiceIds.length === 0) return result;

  const rows = await db
    .select({
      serviceInvoiceId: serviceInvoiceDocuments.serviceInvoiceId,
      documentTypeId: serviceInvoiceDocuments.documentTypeId,
      fileName: serviceInvoiceDocuments.fileName,
      s3Key: serviceInvoiceDocuments.s3Key,
    })
    .from(serviceInvoiceDocuments)
    .where(
      and(
        inArray(serviceInvoiceDocuments.serviceInvoiceId, invoiceIds),
        eq(serviceInvoiceDocuments.isActive, true),
      ),
    );

  for (const row of rows) {
    const docs = result.get(row.serviceInvoiceId) ?? emptyInvoiceDocs();
    const ref: DocFileRef = {
      fileName: row.fileName?.trim() || null,
      s3Key: row.s3Key?.trim() || null,
    };
    if (row.documentTypeId === SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_XLSX) {
      docs.annexureXlsx = ref;
    } else if (
      row.documentTypeId === SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_PDF
    ) {
      docs.annexurePdf = ref;
    } else if (
      row.documentTypeId === SERVICE_INVOICE_DOCUMENT_TYPE_INVOICE_PDF
    ) {
      docs.invoicePdf = ref;
    }
    result.set(row.serviceInvoiceId, docs);
  }
  return result;
}

async function upsertServiceInvoiceDocument(opts: {
  serviceInvoiceId: number;
  documentTypeId: number;
  fileName: string;
  s3Key: string;
  userId: number | null;
  at?: string;
}): Promise<void> {
  const at = opts.at ?? formatUtcNow();
  const [existing] = await db
    .select({ id: serviceInvoiceDocuments.id })
    .from(serviceInvoiceDocuments)
    .where(
      and(
        eq(serviceInvoiceDocuments.serviceInvoiceId, opts.serviceInvoiceId),
        eq(serviceInvoiceDocuments.documentTypeId, opts.documentTypeId),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(serviceInvoiceDocuments)
      .set({
        fileName: opts.fileName,
        s3Key: opts.s3Key,
        isActive: true,
        updatedAt: at,
        updatedBy: opts.userId,
      })
      .where(eq(serviceInvoiceDocuments.id, existing.id));
    return;
  }

  const id = await nextId("service_invoice_documents", "id");
  await db.insert(serviceInvoiceDocuments).values({
    id,
    serviceInvoiceId: opts.serviceInvoiceId,
    documentTypeId: opts.documentTypeId,
    fileName: opts.fileName,
    s3Key: opts.s3Key,
    isActive: true,
    createdAt: at,
    createdBy: opts.userId,
    updatedAt: null,
    updatedBy: null,
  });
}

function mapRow(
  r: {
    id: number;
    clientId: number;
    clientName: string;
    plantLocationId: number;
    plantLocationName: string | null;
    fromDate: string;
    toDate: string;
    type: ServiceInvoiceType;
    orderNumber: string | null;
    orderDate: string | null;
    gracePeriod: number | null;
    totalQuantity: string;
    totalAmount: string;
    serviceFeeType: ServiceFeeType;
    serviceFeeValue: string;
    serviceFeeAmount: string;
    gstPercent: string;
    gstAmount: string;
    grandTotal: string;
    roundOff: string | null;
    serviceChargeDescription: string | null;
    invoiceNumber: string | null;
    invoiceDate: string | null;
    paymentDueDate: string | null;
    paidAmount: string;
    unpaidAmount: string;
    latestPaymentDate: string | null;
    paymentStatus: ServiceInvoicePaymentStatus;
    status: ServiceInvoiceStatus;
    requestedAt: string | null;
    requestedBy: number | null;
    generatedAt: string | null;
    generatedBy: number | null;
    emailSentAt: string | null;
    emailSentBy: number | null;
    recheckedAt: string | null;
    recheckedBy: number | null;
    cancelledAt: string | null;
    cancelledBy: number | null;
    createdAt: string;
    updatedAt: string | null;
  },
  docs: InvoiceDocs,
): ServiceInvoiceListRow {
  return {
    id: r.id,
    clientId: r.clientId,
    clientName: r.clientName,
    plantLocationId: r.plantLocationId,
    plantLocationName: r.plantLocationName,
    fromDate: r.fromDate,
    toDate: r.toDate,
    type: r.type,
    orderNumber: r.orderNumber,
    orderDate: r.orderDate,
    gracePeriod: r.gracePeriod,
    totalQuantity: num(r.totalQuantity),
    totalAmount: num(r.totalAmount),
    serviceFeeType: r.serviceFeeType,
    serviceFeeValue: num(r.serviceFeeValue),
    serviceFeeAmount: num(r.serviceFeeAmount),
    gstPercent: num(r.gstPercent),
    gstAmount: num(r.gstAmount),
    grandTotal: num(r.grandTotal),
    roundOff: numOrNull(r.roundOff),
    serviceChargeDescription: r.serviceChargeDescription,
    invoiceNumber: r.invoiceNumber,
    invoiceDate: r.invoiceDate,
    paymentDueDate: r.paymentDueDate,
    paidAmount: num(r.paidAmount),
    unpaidAmount: num(r.unpaidAmount),
    latestPaymentDate: r.latestPaymentDate,
    paymentStatus: r.paymentStatus,
    annexureXlsxFilename: docs.annexureXlsx.fileName,
    annexureXlsxS3Key: docs.annexureXlsx.s3Key,
    annexureXlsxUrl: null,
    annexurePdfFilename: docs.annexurePdf.fileName,
    annexurePdfS3Key: docs.annexurePdf.s3Key,
    annexurePdfUrl: null,
    invoicePdfFilename: docs.invoicePdf.fileName,
    invoicePdfS3Key: docs.invoicePdf.s3Key,
    invoicePdfUrl: null,
    hasAnnexure: Boolean(docs.annexureXlsx.s3Key),
    status: r.status,
    requestedAt: r.requestedAt,
    requestedBy: r.requestedBy,
    generatedAt: r.generatedAt,
    generatedBy: r.generatedBy,
    emailSentAt: r.emailSentAt,
    emailSentBy: r.emailSentBy,
    recheckedAt: r.recheckedAt,
    recheckedBy: r.recheckedBy,
    cancelledAt: r.cancelledAt,
    cancelledBy: r.cancelledBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function attachFileUrls(
  row: ServiceInvoiceListRow,
): Promise<ServiceInvoiceListRow> {
  const [annexureXlsxUrl, annexurePdfUrl, invoicePdfUrl] = await Promise.all([
    row.annexureXlsxS3Key
      ? signedServiceInvoiceAnnexureUrl(row.annexureXlsxS3Key)
      : null,
    row.annexurePdfS3Key
      ? signedServiceInvoiceAnnexureUrl(row.annexurePdfS3Key, {
          disposition: "inline",
          contentType: SI_PDF_CONTENT_TYPE,
        })
      : null,
    row.invoicePdfS3Key
      ? signedServiceInvoiceAnnexureUrl(row.invoicePdfS3Key, {
          disposition: "inline",
          contentType: SI_PDF_CONTENT_TYPE,
        })
      : null,
  ]);
  return {
    ...row,
    annexureXlsxUrl,
    annexurePdfUrl,
    invoicePdfUrl,
  };
}

const listSelect = {
  id: serviceInvoices.id,
  clientId: serviceInvoices.clientId,
  clientName: clients.companyName,
  plantLocationId: serviceInvoices.plantLocationId,
  plantLocationName: plantLocations.name,
  fromDate: serviceInvoices.fromDate,
  toDate: serviceInvoices.toDate,
  type: serviceInvoices.type,
  orderNumber: serviceInvoices.orderNumber,
  orderDate: serviceInvoices.orderDate,
  gracePeriod: serviceInvoices.gracePeriod,
  totalQuantity: serviceInvoices.totalQuantity,
  totalAmount: serviceInvoices.totalAmount,
  serviceFeeType: serviceInvoices.serviceFeeType,
  serviceFeeValue: serviceInvoices.serviceFeeValue,
  serviceFeeAmount: serviceInvoices.serviceFeeAmount,
  gstPercent: serviceInvoices.gstPercent,
  gstAmount: serviceInvoices.gstAmount,
  grandTotal: serviceInvoices.grandTotal,
  roundOff: serviceInvoices.roundOff,
  serviceChargeDescription: serviceInvoices.serviceChargeDescription,
  invoiceNumber: serviceInvoices.invoiceNumber,
  invoiceDate: serviceInvoices.invoiceDate,
  paymentDueDate: serviceInvoices.paymentDueDate,
  paidAmount: serviceInvoices.paidAmount,
  unpaidAmount: serviceInvoices.unpaidAmount,
  latestPaymentDate: serviceInvoices.latestPaymentDate,
  paymentStatus: serviceInvoices.paymentStatus,
  status: serviceInvoices.status,
  requestedAt: serviceInvoices.requestedAt,
  requestedBy: serviceInvoices.requestedBy,
  generatedAt: serviceInvoices.generatedAt,
  generatedBy: serviceInvoices.generatedBy,
  emailSentAt: serviceInvoices.emailSentAt,
  emailSentBy: serviceInvoices.emailSentBy,
  recheckedAt: serviceInvoices.recheckedAt,
  recheckedBy: serviceInvoices.recheckedBy,
  cancelledAt: serviceInvoices.cancelledAt,
  cancelledBy: serviceInvoices.cancelledBy,
  createdAt: serviceInvoices.createdAt,
  updatedAt: serviceInvoices.updatedAt,
};

function dateRange(
  column:
    | typeof serviceInvoices.createdAt
    | typeof serviceInvoices.requestedAt
    | typeof serviceInvoices.generatedAt
    | typeof serviceInvoices.recheckedAt
    | typeof serviceInvoices.cancelledAt,
  opts: Omit<ServiceInvoicesListParams, "page" | "pageSize">,
  field:
    | "createdAt"
    | "requestedAt"
    | "generatedAt"
    | "recheckedAt"
    | "cancelledAt",
): SQL | undefined {
  if (opts.dateField !== field || !opts.dateFrom) return undefined;
  if (opts.dateTo) {
    return sql`${column}::date >= CAST(${opts.dateFrom} AS date) AND ${column}::date <= CAST(${opts.dateTo} AS date)`;
  }
  return sql`${column}::date >= CAST(${opts.dateFrom} AS date)`;
}

/** Invoice billing period overlaps [dateFrom, dateTo] (inclusive). */
function periodOverlap(
  opts: Omit<ServiceInvoicesListParams, "page" | "pageSize">,
): SQL | undefined {
  if (opts.dateField !== "period" || !opts.dateFrom) return undefined;
  const rangeTo = opts.dateTo ?? opts.dateFrom;
  return sql`${serviceInvoices.fromDate}::date <= CAST(${rangeTo} AS date) AND ${serviceInvoices.toDate}::date >= CAST(${opts.dateFrom} AS date)`;
}

function buildWhere(
  opts: Omit<ServiceInvoicesListParams, "page" | "pageSize">,
): SQL | undefined {
  const search = opts.search?.trim();
  const outstanding = opts.outstanding === true;
  const conditions: (SQL | undefined)[] = [
    opts.clientId != null
      ? eq(serviceInvoices.clientId, opts.clientId)
      : undefined,
    outstanding
      ? and(
          eq(serviceInvoices.status, "generated"),
          sql`${serviceInvoices.unpaidAmount} > 0`,
        )
      : opts.status != null
        ? eq(serviceInvoices.status, opts.status)
        : undefined,
    !outstanding && opts.excludeDraft && opts.status == null
      ? ne(serviceInvoices.status, "draft")
      : undefined,
    opts.type != null ? eq(serviceInvoices.type, opts.type) : undefined,
    opts.serviceFeeType != null
      ? eq(serviceInvoices.serviceFeeType, opts.serviceFeeType)
      : undefined,
    periodOverlap(opts),
    dateRange(serviceInvoices.createdAt, opts, "createdAt"),
    dateRange(serviceInvoices.requestedAt, opts, "requestedAt"),
    dateRange(serviceInvoices.generatedAt, opts, "generatedAt"),
    dateRange(serviceInvoices.recheckedAt, opts, "recheckedAt"),
    dateRange(serviceInvoices.cancelledAt, opts, "cancelledAt"),
  ];

  if (search) {
    const term = `%${search}%`;
    conditions.push(
      or(
        ilike(sql`cast(${serviceInvoices.id} as text)`, term),
        ilike(clients.companyName, term),
        ilike(plantLocations.name, term),
        ilike(serviceInvoices.orderNumber, term),
      )!,
    );
  }

  return combineConditions(conditions);
}

function buildSort(
  sortBy: ServiceInvoicesListParams["sortBy"],
  sortOrder: ServiceInvoicesListParams["sortOrder"],
) {
  const dir = sortOrder === "asc" ? asc : desc;
  if (sortBy && SORT_FIELDS.has(sortBy)) {
    if (sortBy === "clientName") return [dir(clients.companyName)];
    if (sortBy === "id") return [dir(serviceInvoices.id)];
    if (sortBy === "fromDate") return [dir(serviceInvoices.fromDate)];
    if (sortBy === "toDate") return [dir(serviceInvoices.toDate)];
    if (sortBy === "grandTotal") return [dir(serviceInvoices.grandTotal)];
    if (sortBy === "status") return [dir(serviceInvoices.status)];
    if (sortBy === "createdAt") return [dir(serviceInvoices.createdAt)];
  }
  return [desc(serviceInvoices.id)];
}

async function assertClientExists(clientId: number): Promise<void> {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!row) throw new ServiceInvoiceClientNotFoundError();
}

async function assertPlantForClient(
  plantLocationId: number,
  clientId: number,
  opts?: { allowInactiveId?: number },
): Promise<void> {
  const [row] = await db
    .select({
      id: plantLocations.id,
      clientId: plantLocations.clientId,
      isActive: plantLocations.isActive,
    })
    .from(plantLocations)
    .where(eq(plantLocations.id, plantLocationId))
    .limit(1);
  if (!row) throw new ServiceInvoicePlantNotFoundError();
  if (row.clientId !== clientId) throw new ServiceInvoicePlantNotFoundError();
  if (
    !row.isActive &&
    (opts?.allowInactiveId == null || row.id !== opts.allowInactiveId)
  ) {
    throw new ServiceInvoicePlantNotFoundError();
  }
}

async function decodeAnnexureBase64(base64: string): Promise<Buffer> {
  try {
    const raw = base64.includes(",") ? base64.split(",").pop()! : base64;
    const buffer = Buffer.from(raw, "base64");
    if (buffer.length === 0) {
      throw new Error("empty");
    }
    return buffer;
  } catch {
    throw new ServiceInvoiceAnnexureError(
      ServiceInvoicesValidationMessages.ANNEXURE_FILE_INVALID,
    );
  }
}

async function resolveAnnexureForSave(opts: {
  type: ServiceInvoiceType;
  serviceFeeType: ServiceFeeType;
  clientId: number;
  plantLocationId: number;
  fromDate: string;
  toDate: string;
  invoiceId: number;
  annexureFileBase64?: string;
  previousS3Key?: string | null;
}): Promise<{
  lines: ServiceInvoiceAnnexureLine[];
  s3Key: string | null;
  filename: string | null;
}> {
  if (opts.annexureFileBase64) {
    const buffer = await decodeAnnexureBase64(opts.annexureFileBase64);
    const parsed = await parseServiceInvoiceAnnexureBuffer(buffer);
    if (!parsed.lines?.length || parsed.imported === 0) {
      throw new ServiceInvoiceAnnexureError(
        ServiceInvoicesValidationMessages.ANNEXURE_REQUIRED,
      );
    }
    const stored = await persistServiceInvoiceAnnexure({
      invoiceId: opts.invoiceId,
      clientId: opts.clientId,
      buffer,
      previousS3Key: opts.previousS3Key,
    });
    return {
      lines: parsed.lines,
      s3Key: stored.s3Key,
      filename: stored.filename,
    };
  }

  if (opts.type === "auto") {
    const auto = await fetchAutoAnnexureLines({
      clientId: opts.clientId,
      plantLocationId: opts.plantLocationId,
      fromDate: opts.fromDate,
      toDate: opts.toDate,
    });
    if (auto.lines.length === 0) {
      throw new ServiceInvoiceAnnexureError(
        ServiceInvoicesValidationMessages.ANNEXURE_EMPTY,
      );
    }
    const buffer = await buildServiceInvoiceAnnexureXlsxFromLines(auto.lines);
    const stored = await persistServiceInvoiceAnnexure({
      invoiceId: opts.invoiceId,
      clientId: opts.clientId,
      buffer,
      previousS3Key: opts.previousS3Key,
    });
    return {
      lines: auto.lines,
      s3Key: stored.s3Key,
      filename: stored.filename,
    };
  }

  // manual without new file — keep previous
  if (opts.previousS3Key) {
    const buffer = await readServiceInvoiceAnnexureBuffer(opts.previousS3Key);
    const parsed = await parseServiceInvoiceAnnexureBuffer(buffer);
    if (!parsed.lines?.length) {
      throw new ServiceInvoiceAnnexureError(
        ServiceInvoicesValidationMessages.ANNEXURE_REQUIRED,
      );
    }
    return {
      lines: parsed.lines,
      s3Key: opts.previousS3Key,
      filename: null,
    };
  }
  throw new ServiceInvoiceAnnexureError(
    ServiceInvoicesValidationMessages.ANNEXURE_REQUIRED,
  );
}

function shouldAutoGenerateAnnexurePdf(opts: {
  status: ServiceInvoiceStatus;
  hasAnnexureXlsx: boolean;
}): boolean {
  return opts.status === "requested" && opts.hasAnnexureXlsx;
}

async function persistBuiltAnnexurePdf(opts: {
  invoiceId: number;
  clientId: number;
  previousPdfS3Key: string | null;
  userId: number | null;
  pdfInput: AnnexurePdfInput;
}): Promise<{ s3Key: string; filename: string }> {
  let buffer: Buffer;
  try {
    buffer = await buildAnnexurePdf(opts.pdfInput);
  } catch {
    throw new ServiceInvoiceAnnexureError(
      ServiceInvoicesValidationMessages.ANNEXURE_PDF_GENERATE_FAILED,
    );
  }
  try {
    const stored = await persistServiceInvoicePdf({
      kind: "annexure",
      invoiceId: opts.invoiceId,
      clientId: opts.clientId,
      buffer,
      previousS3Key: opts.previousPdfS3Key,
    });
    await upsertServiceInvoiceDocument({
      serviceInvoiceId: opts.invoiceId,
      documentTypeId: SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_PDF,
      fileName: stored.filename,
      s3Key: stored.s3Key,
      userId: opts.userId,
    });
    return stored;
  } catch (e) {
    if (e instanceof ServiceInvoiceAnnexureError) throw e;
    throw new ServiceInvoiceAnnexureError(
      ServiceInvoicesValidationMessages.ANNEXURE_PDF_GENERATE_FAILED,
    );
  }
}

export const serviceInvoicesService = {
  async list(
    opts: ServiceInvoicesListParams,
  ): Promise<ServiceInvoiceListResult> {
    const { page, pageSize, offset } = clampPagination(
      opts.page,
      opts.pageSize,
    );
    const where = buildWhere(opts);
    const orderBy = buildSort(opts.sortBy, opts.sortOrder);

    const base = db
      .select(listSelect)
      .from(serviceInvoices)
      .innerJoin(clients, eq(serviceInvoices.clientId, clients.id))
      .innerJoin(
        plantLocations,
        eq(serviceInvoices.plantLocationId, plantLocations.id),
      );

    const countBase = db
      .select({ count: sql<number>`count(*)::int` })
      .from(serviceInvoices)
      .innerJoin(clients, eq(serviceInvoices.clientId, clients.id))
      .innerJoin(
        plantLocations,
        eq(serviceInvoices.plantLocationId, plantLocations.id),
      );

    const [rows, countRows] = await Promise.all([
      (where ? base.where(where) : base)
        .orderBy(...orderBy)
        .limit(pageSize)
        .offset(offset),
      where ? countBase.where(where) : countBase,
    ]);

    const docsById = await docsByInvoiceIds(rows.map((r) => r.id));
    return {
      items: await Promise.all(
        rows.map((r) =>
          attachFileUrls(mapRow(r, docsById.get(r.id) ?? emptyInvoiceDocs())),
        ),
      ),
      total: Number(countRows[0]?.count ?? 0),
      page,
      pageSize,
    };
  },

  /**
   * All matching rows for Excel export (ignores UI pagination).
   * When `ids` is non-empty, exports those IDs only (filters unused).
   * Skips signed URL attachment.
   */
  async listAllForExport(
    opts: ServiceInvoicesExportParams,
  ): Promise<ServiceInvoiceListRow[]> {
    const ids = opts.ids ?? [];
    const where =
      ids.length > 0 ? inArray(serviceInvoices.id, ids) : buildWhere(opts);
    const orderBy = buildSort(opts.sortBy, opts.sortOrder);

    const rows: ServiceInvoiceListRow[] = [];
    let offset = 0;
    while (rows.length < SERVICE_INVOICE_EXPORT_MAX_ROWS) {
      const take = Math.min(
        SERVICE_INVOICE_EXPORT_PAGE_SIZE,
        SERVICE_INVOICE_EXPORT_MAX_ROWS - rows.length,
      );
      const base = db
        .select(listSelect)
        .from(serviceInvoices)
        .innerJoin(clients, eq(serviceInvoices.clientId, clients.id))
        .innerJoin(
          plantLocations,
          eq(serviceInvoices.plantLocationId, plantLocations.id),
        );
      const pageRows = await (where ? base.where(where) : base)
        .orderBy(...orderBy)
        .limit(take)
        .offset(offset);
      if (pageRows.length === 0) break;
      const docsById = await docsByInvoiceIds(pageRows.map((r) => r.id));
      for (const r of pageRows) {
        rows.push(mapRow(r, docsById.get(r.id) ?? emptyInvoiceDocs()));
      }
      if (pageRows.length < take) break;
      offset += pageRows.length;
    }
    return rows;
  },

  async findIdByInvoiceNumber(invoiceNumber: string): Promise<number | null> {
    const normalized = invoiceNumber.trim();
    if (!normalized) return null;
    const [row] = await db
      .select({ id: serviceInvoices.id })
      .from(serviceInvoices)
      .where(eq(serviceInvoices.invoiceNumber, normalized))
      .limit(1);
    return row?.id ?? null;
  },

  async get(id: number): Promise<ServiceInvoiceListRow | null> {
    const [row] = await db
      .select(listSelect)
      .from(serviceInvoices)
      .innerJoin(clients, eq(serviceInvoices.clientId, clients.id))
      .innerJoin(
        plantLocations,
        eq(serviceInvoices.plantLocationId, plantLocations.id),
      )
      .where(eq(serviceInvoices.id, id))
      .limit(1);
    if (!row) return null;
    const docsById = await docsByInvoiceIds([id]);
    return attachFileUrls(mapRow(row, docsById.get(id) ?? emptyInvoiceDocs()));
  },

  async getAnnexurePreview(id: number): Promise<{
    lines: ServiceInvoiceAnnexureLine[];
    totals: { totalQuantity: number; totalAmount: number };
  }> {
    const row = await this.get(id);
    if (!row) throw new ServiceInvoiceNotFoundError();
    if (!row.annexureXlsxS3Key) {
      throw new ServiceInvoiceAnnexureError(
        ServiceInvoicesValidationMessages.ANNEXURE_NOT_FOUND,
      );
    }
    const buffer = await readServiceInvoiceAnnexureBuffer(row.annexureXlsxS3Key);
    const parsed = await parseServiceInvoiceAnnexureBuffer(buffer);
    if (!parsed.lines?.length) {
      throw new ServiceInvoiceAnnexureError(
        parsed.issues[0]?.message ??
          ServiceInvoicesValidationMessages.ANNEXURE_EMPTY,
      );
    }
    return {
      lines: parsed.lines,
      totals: parsed.totals ?? aggregateAnnexureTotals(parsed.lines),
    };
  },

  async getAnnexureDownloadUrl(id: number): Promise<{ url: string }> {
    const row = await this.get(id);
    if (!row) throw new ServiceInvoiceNotFoundError();
    if (isCancelledStatus(row.status)) {
      throw new ServiceInvoiceAnnexureError(
        ServiceInvoicesErrorMessages.CANCELLED_LOCKED,
      );
    }
    if (!row.annexureXlsxS3Key) {
      throw new ServiceInvoiceAnnexureError(
        ServiceInvoicesValidationMessages.ANNEXURE_NOT_FOUND,
      );
    }
    const url = await signedServiceInvoiceAnnexureUrl(row.annexureXlsxS3Key);
    return { url };
  },

  /**
   * Rebuild annexure PDF from stored XLSX + current invoice fee fields,
   * persist, return signed URL. Applies to all service fee types.
   */
  async generateAndPersistAnnexurePdf(
    id: number,
    userId: number | undefined,
  ): Promise<{ s3Key: string; filename: string; url: string }> {
    const row = await this.get(id);
    if (!row) throw new ServiceInvoiceNotFoundError();
    if (isCancelledStatus(row.status)) {
      throw new ServiceInvoiceAnnexureError(
        ServiceInvoicesErrorMessages.CANCELLED_LOCKED,
      );
    }
    if (!row.annexureXlsxS3Key) {
      throw new ServiceInvoiceAnnexureError(
        ServiceInvoicesValidationMessages.ANNEXURE_NOT_FOUND,
      );
    }

    const preview = await this.getAnnexurePreview(id);
    const stored = await persistBuiltAnnexurePdf({
      invoiceId: id,
      clientId: row.clientId,
      previousPdfS3Key: row.annexurePdfS3Key,
      userId: userId ?? null,
      pdfInput: {
        lines: preview.lines,
        clientName: row.clientName,
        plantLocationName: row.plantLocationName,
        totalQuantity: row.totalQuantity,
        totalAmount: row.totalAmount,
        serviceFeeType: row.serviceFeeType,
        serviceFeeValue: row.serviceFeeValue,
        serviceFeeAmount: row.serviceFeeAmount,
      },
    });

    const url = await signedServiceInvoiceAnnexureUrl(stored.s3Key, {
      disposition: "attachment",
      contentType: SI_PDF_CONTENT_TYPE,
    });
    return { ...stored, url };
  },

  async getAnnexurePdfDownloadUrl(
    id: number,
    userId: number | undefined,
  ): Promise<{ url: string }> {
    const result = await this.generateAndPersistAnnexurePdf(id, userId);
    return { url: result.url };
  },

  async create(
    input: CreateServiceInvoiceInput,
    userId: number | undefined,
  ): Promise<ServiceInvoiceListRow> {
    await assertClientExists(input.clientId);
    await assertPlantForClient(input.plantLocationId, input.clientId);

    const id = await nextId("service_invoices", "id");
    const now = formatUtcNow();

    const annexure = await resolveAnnexureForSave({
      type: input.type,
      serviceFeeType: input.serviceFeeType,
      clientId: input.clientId,
      plantLocationId: input.plantLocationId,
      fromDate: input.fromDate,
      toDate: input.toDate,
      invoiceId: id,
      annexureFileBase64: input.annexureFileBase64,
    });

    const fromLines =
      annexure.lines.length > 0
        ? aggregateAnnexureTotals(annexure.lines)
        : {
            totalQuantity: input.totalQuantity,
            totalAmount: input.totalAmount,
          };

    const totals = computeFeeTotals({
      serviceFeeType: input.serviceFeeType,
      serviceFeeValue: input.serviceFeeValue,
      totalQuantity: fromLines.totalQuantity,
      totalAmount: fromLines.totalAmount,
      gstPercent: input.gstPercent,
    });

    await db.insert(serviceInvoices).values({
      id,
      clientId: input.clientId,
      plantLocationId: input.plantLocationId,
      fromDate: input.fromDate,
      toDate: input.toDate,
      type: input.type,
      orderNumber: input.orderNumber?.trim() || null,
      orderDate: input.orderDate?.trim() || null,
      gracePeriod: input.gracePeriod,
      totalQuantity: toNumericString(fromLines.totalQuantity, 3),
      totalAmount: toNumericString(fromLines.totalAmount, 3),
      serviceFeeType: input.serviceFeeType,
      serviceFeeValue: toNumericString(input.serviceFeeValue, 4),
      serviceFeeAmount: toNumericString(totals.serviceFeeAmount, 3),
      gstPercent: toNumericString(input.gstPercent, 2),
      gstAmount: toNumericString(totals.gstAmount, 2),
      grandTotal: toNumericString(totals.grandTotal, 3),
      roundOff: toNumericString(totals.roundOff, 2),
      serviceChargeDescription: input.serviceChargeDescription.trim(),
      paidAmount: "0",
      unpaidAmount: toNumericString(totals.grandTotal, 3),
      latestPaymentDate: null,
      paymentStatus: "unpaid",
      status: input.status,
      ...statusStampFields(input.status, now, userId ?? null),
      createdAt: now,
      createdBy: userId ?? null,
      updatedAt: null,
      updatedBy: null,
    });

    if (annexure.s3Key && annexure.filename) {
      await upsertServiceInvoiceDocument({
        serviceInvoiceId: id,
        documentTypeId: SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_XLSX,
        fileName: annexure.filename,
        s3Key: annexure.s3Key,
        userId: userId ?? null,
        at: now,
      });
    }

    if (
      shouldAutoGenerateAnnexurePdf({
        status: input.status,
        hasAnnexureXlsx: Boolean(annexure.s3Key),
      })
    ) {
      try {
        await this.generateAndPersistAnnexurePdf(id, userId);
      } catch (e) {
        await db
          .delete(serviceInvoiceDocuments)
          .where(eq(serviceInvoiceDocuments.serviceInvoiceId, id));
        await db.delete(serviceInvoices).where(eq(serviceInvoices.id, id));
        if (e instanceof ServiceInvoiceAnnexureError) throw e;
        throw new ServiceInvoiceAnnexureError(
          ServiceInvoicesValidationMessages.ANNEXURE_PDF_GENERATE_FAILED,
        );
      }
    }

    const created = await this.get(id);
    if (!created) throw new ServiceInvoiceNotFoundError();
    return created;
  },

  async update(
    id: number,
    input: PatchServiceInvoiceInput,
    userId: number | undefined,
  ): Promise<ServiceInvoiceListRow> {
    const existing = await this.get(id);
    if (!existing) throw new ServiceInvoiceNotFoundError();
    if (!isAdminEditableStatus(existing.status)) {
      throw new ServiceInvoiceLockedError();
    }

    const plantLocationId = input.plantLocationId ?? existing.plantLocationId;
    if (input.plantLocationId != null) {
      await assertPlantForClient(plantLocationId, existing.clientId, {
        allowInactiveId: existing.plantLocationId,
      });
    }

    const fromDate = input.fromDate ?? existing.fromDate;
    const toDate = input.toDate ?? existing.toDate;
    if (new Date(toDate) < new Date(fromDate)) {
      throw new ServiceInvoiceValidationError(
        ServiceInvoicesValidationMessages.DATE_RANGE_INVALID,
        { toDate: [ServiceInvoicesValidationMessages.DATE_RANGE_INVALID] },
      );
    }

    const type = input.type ?? existing.type;
    const serviceFeeType = input.serviceFeeType ?? existing.serviceFeeType;
    const serviceFeeValue = input.serviceFeeValue ?? existing.serviceFeeValue;
    const gstPercent = input.gstPercent ?? existing.gstPercent;

    const annexure = await resolveAnnexureForSave({
      type,
      serviceFeeType,
      clientId: existing.clientId,
      plantLocationId,
      fromDate,
      toDate,
      invoiceId: id,
      annexureFileBase64: input.annexureFileBase64,
      previousS3Key: existing.annexureXlsxS3Key,
    });

    const fromLines =
      annexure.lines.length > 0
        ? aggregateAnnexureTotals(annexure.lines)
        : {
            totalQuantity: input.totalQuantity ?? existing.totalQuantity,
            totalAmount: input.totalAmount ?? existing.totalAmount,
          };

    const totals = computeFeeTotals({
      serviceFeeType,
      serviceFeeValue,
      totalQuantity: fromLines.totalQuantity,
      totalAmount: fromLines.totalAmount,
      gstPercent,
    });

    const now = formatUtcNow();
    const nextStatus = input.status ?? existing.status;
    await db
      .update(serviceInvoices)
      .set({
        plantLocationId,
        fromDate,
        toDate,
        type,
        orderNumber:
          input.orderNumber !== undefined
            ? input.orderNumber?.trim() || null
            : existing.orderNumber,
        orderDate:
          input.orderDate !== undefined
            ? input.orderDate?.trim() || null
            : existing.orderDate,
        gracePeriod:
          input.gracePeriod !== undefined
            ? input.gracePeriod
            : existing.gracePeriod,
        totalQuantity: toNumericString(fromLines.totalQuantity, 3),
        totalAmount: toNumericString(fromLines.totalAmount, 3),
        serviceFeeType,
        serviceFeeValue: toNumericString(serviceFeeValue, 4),
        serviceFeeAmount: toNumericString(totals.serviceFeeAmount, 3),
        gstPercent: toNumericString(gstPercent, 2),
        gstAmount: toNumericString(totals.gstAmount, 2),
        grandTotal: toNumericString(totals.grandTotal, 3),
        roundOff: toNumericString(totals.roundOff, 2),
        unpaidAmount: toNumericString(
          Math.max(0, totals.grandTotal - existing.paidAmount),
          3,
        ),
        paymentStatus: derivePaymentStatus(
          existing.paidAmount,
          totals.grandTotal,
        ),
        serviceChargeDescription:
          input.serviceChargeDescription !== undefined
            ? input.serviceChargeDescription.trim()
            : existing.serviceChargeDescription,
        status: nextStatus,
        ...(nextStatus !== existing.status
          ? statusStampFields(nextStatus, now, userId ?? null)
          : {}),
        updatedAt: now,
        updatedBy: userId ?? null,
      })
      .where(eq(serviceInvoices.id, id));

    if (annexure.s3Key && annexure.filename) {
      await upsertServiceInvoiceDocument({
        serviceInvoiceId: id,
        documentTypeId: SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_XLSX,
        fileName: annexure.filename,
        s3Key: annexure.s3Key,
        userId: userId ?? null,
        at: now,
      });
    }

    if (
      shouldAutoGenerateAnnexurePdf({
        status: nextStatus,
        hasAnnexureXlsx: Boolean(annexure.s3Key ?? existing.annexureXlsxS3Key),
      })
    ) {
      try {
        await this.generateAndPersistAnnexurePdf(id, userId);
      } catch (e) {
        if (nextStatus === "requested" && existing.status !== "requested") {
          await db
            .update(serviceInvoices)
            .set({
              status: existing.status,
              requestedAt: existing.requestedAt,
              requestedBy: existing.requestedBy,
              updatedAt: now,
              updatedBy: userId ?? null,
            })
            .where(eq(serviceInvoices.id, id));
        }
        if (e instanceof ServiceInvoiceAnnexureError) throw e;
        throw new ServiceInvoiceAnnexureError(
          ServiceInvoicesValidationMessages.ANNEXURE_PDF_GENERATE_FAILED,
        );
      }
    }

    const updated = await this.get(id);
    if (!updated) throw new ServiceInvoiceNotFoundError();
    return updated;
  },

  async stats(clientId?: number): Promise<ServiceInvoiceStats> {
    const [row] = await db
      .select({
        draft: sql<number>`count(*) filter (where ${serviceInvoices.status} = 'draft')::int`,
        requested: sql<number>`count(*) filter (where ${serviceInvoices.status} = 'requested')::int`,
        recheck: sql<number>`count(*) filter (where ${serviceInvoices.status} = 'recheck')::int`,
        generated: sql<number>`count(*) filter (where ${serviceInvoices.status} = 'generated')::int`,
        cancelled: sql<number>`count(*) filter (where ${serviceInvoices.status} = 'cancelled')::int`,
        total: sql<number>`count(*) filter (where ${serviceInvoices.status} <> 'draft')::int`,
      })
      .from(serviceInvoices)
      .where(
        clientId != null ? eq(serviceInvoices.clientId, clientId) : undefined,
      );
    return {
      draft: Number(row?.draft ?? 0),
      requested: Number(row?.requested ?? 0),
      recheck: Number(row?.recheck ?? 0),
      generated: Number(row?.generated ?? 0),
      cancelled: Number(row?.cancelled ?? 0),
      total: Number(row?.total ?? 0),
    };
  },

  async outstandingStats(
    clientId?: number,
  ): Promise<ServiceInvoiceOutstandingStats> {
    const [row] = await db
      .select({
        count: sql<number>`count(*)::int`,
        amount: sql<string>`COALESCE(SUM(${serviceInvoices.unpaidAmount}), 0)`,
      })
      .from(serviceInvoices)
      .where(
        and(
          eq(serviceInvoices.status, "generated"),
          sql`${serviceInvoices.unpaidAmount} > 0`,
          clientId != null
            ? eq(serviceInvoices.clientId, clientId)
            : undefined,
        ),
      );
    return {
      count: Number(row?.count ?? 0),
      amount: num(row?.amount),
    };
  },

  async accountsUpdate(
    id: number,
    input: AccountsServiceInvoiceActionInput,
    userId: number | undefined,
  ): Promise<ServiceInvoiceListRow> {
    const existing = await this.get(id);
    if (!existing) throw new ServiceInvoiceNotFoundError();

    const writingInvoiceFields =
      input.invoiceNumber !== undefined ||
      input.invoiceDate !== undefined ||
      input.paymentDueDate !== undefined;
    const changingStatus =
      input.status != null && input.status !== existing.status;

    if (writingInvoiceFields) {
      if (!ACCOUNTS_FIELD_EDITABLE_STATUSES.has(existing.status)) {
        throw new ServiceInvoiceAccountsTransitionError(
          ServiceInvoicesValidationMessages.INVALID_ACCOUNTS_TRANSITION,
        );
      }
    }

    if (changingStatus) {
      const allowed = ACCOUNTS_STATUS_TRANSITIONS[existing.status];
      if (!allowed.has(input.status!)) {
        throw new ServiceInvoiceAccountsTransitionError(
          ServiceInvoicesValidationMessages.INVALID_ACCOUNTS_TRANSITION,
        );
      }
    } else if (!writingInvoiceFields) {
      // Status omitted/unchanged and no invoice fields — nothing to do.
      throw new ServiceInvoiceAccountsTransitionError(
        ServiceInvoicesValidationMessages.ACCOUNTS_ACTION_EMPTY,
      );
    }

    const nextInvoiceNumber =
      input.invoiceNumber !== undefined
        ? input.invoiceNumber.trim()
        : (existing.invoiceNumber?.trim() ?? "");
    const nextInvoiceDate =
      input.invoiceDate !== undefined
        ? input.invoiceDate.trim()
        : (existing.invoiceDate?.trim() ?? "");
    const nextPaymentDueDate =
      input.paymentDueDate !== undefined
        ? input.paymentDueDate.trim()
        : (existing.paymentDueDate?.trim() ?? "");

    if (writingInvoiceFields) {
      if (!nextInvoiceNumber) {
        throw new ServiceInvoiceAccountsTransitionError(
          ServiceInvoicesValidationMessages.INVOICE_NUMBER_REQUIRED,
        );
      }
      if (!nextInvoiceDate) {
        throw new ServiceInvoiceAccountsTransitionError(
          ServiceInvoicesValidationMessages.INVOICE_DATE_REQUIRED,
        );
      }
      if (!nextPaymentDueDate) {
        throw new ServiceInvoiceAccountsTransitionError(
          ServiceInvoicesValidationMessages.PAYMENT_DUE_DATE_REQUIRED,
        );
      }
      await assertServiceInvoiceNumberAvailable(nextInvoiceNumber, id);
    }

    if (input.status === "generated") {
      const needsAnnexurePdf = serviceInvoiceRequiresAnnexurePdf(
        existing.serviceFeeType,
      );
      if (!existing.invoicePdfS3Key) {
        throw new ServiceInvoiceAccountsTransitionError(
          needsAnnexurePdf
            ? ServiceInvoicesValidationMessages.BOTH_PDFS_REQUIRED
            : ServiceInvoicesValidationMessages.INVOICE_PDF_REQUIRED,
        );
      }
      if (needsAnnexurePdf && !existing.annexurePdfS3Key) {
        throw new ServiceInvoiceAccountsTransitionError(
          ServiceInvoicesValidationMessages.BOTH_PDFS_REQUIRED,
        );
      }
      if (!nextInvoiceNumber || !nextInvoiceDate || !nextPaymentDueDate) {
        throw new ServiceInvoiceAccountsTransitionError(
          ServiceInvoicesValidationMessages.INVOICE_DETAILS_REQUIRED_FOR_GENERATED,
        );
      }
    }

    const now = formatUtcNow();
    const nextStatus = input.status ?? existing.status;
    try {
      await db
        .update(serviceInvoices)
        .set({
          ...(writingInvoiceFields
            ? {
                invoiceNumber: nextInvoiceNumber,
                invoiceDate: nextInvoiceDate,
                paymentDueDate: nextPaymentDueDate,
              }
            : {}),
          status: nextStatus,
          ...(changingStatus
            ? statusStampFields(nextStatus, now, userId ?? null)
            : {}),
          updatedAt: now,
          updatedBy: userId ?? null,
        })
        .where(eq(serviceInvoices.id, id));
    } catch (err) {
      if (isServiceInvoiceNumberUniqueViolation(err)) {
        throw duplicateServiceInvoiceNumberError();
      }
      throw err;
    }

    const updated = await this.get(id);
    if (!updated) throw new ServiceInvoiceNotFoundError();
    return updated;
  },

  async uploadAnnexurePdf(
    id: number,
    file: { buffer: Buffer; originalname: string },
    userId: number | undefined,
  ): Promise<ServiceInvoiceListRow> {
    return uploadPdfForInvoice(id, "annexure", file, userId);
  },

  async uploadInvoicePdf(
    id: number,
    file: { buffer: Buffer; originalname: string },
    userId: number | undefined,
  ): Promise<ServiceInvoiceListRow> {
    return uploadPdfForInvoice(id, "invoice", file, userId);
  },

  /**
   * Enqueue annexure + invoice PDF emails for selected invoices (one row per
   * invoice). Attachments must already exist in R2 — nothing is generated here.
   * Only `generated` invoices are eligible. Stamps `email_sent_*` happen in the
   * worker after SMTP/SendGrid success.
   */
  async bulkSendEmail(
    ids: number[],
    enqueuedBy?: number | null,
  ): Promise<{
    queued: number;
    results: Array<{
      id: number;
      ok: boolean;
      emailLogId?: number;
      error?: string;
    }>;
  }> {
    const uniqueIds = [
      ...new Set(ids.filter((id) => Number.isInteger(id) && id > 0)),
    ];
    const results: Array<{
      id: number;
      ok: boolean;
      emailLogId?: number;
      error?: string;
    }> = [];

    if (uniqueIds.length === 0) {
      return { queued: 0, results };
    }

    const invoiceRows = await db
      .select({
        id: serviceInvoices.id,
        status: serviceInvoices.status,
        serviceFeeType: serviceInvoices.serviceFeeType,
        invoiceNumber: serviceInvoices.invoiceNumber,
        invoiceDate: serviceInvoices.invoiceDate,
        toDate: serviceInvoices.toDate,
        grandTotal: serviceInvoices.grandTotal,
        clientName: clients.companyName,
        plantLocationName: plantLocations.name,
        billingName: plantLocations.billingName,
        billingEmailTo: plantLocations.billingEmailTo,
        billingEmailCc: plantLocations.billingEmailCc,
      })
      .from(serviceInvoices)
      .innerJoin(clients, eq(serviceInvoices.clientId, clients.id))
      .innerJoin(
        plantLocations,
        eq(serviceInvoices.plantLocationId, plantLocations.id),
      )
      .where(inArray(serviceInvoices.id, uniqueIds));

    const byId = new Map(invoiceRows.map((r) => [r.id, r]));

    const docRows = await db
      .select({
        serviceInvoiceId: serviceInvoiceDocuments.serviceInvoiceId,
        documentTypeId: serviceInvoiceDocuments.documentTypeId,
        s3Key: serviceInvoiceDocuments.s3Key,
        fileName: serviceInvoiceDocuments.fileName,
      })
      .from(serviceInvoiceDocuments)
      .where(
        and(
          inArray(serviceInvoiceDocuments.serviceInvoiceId, uniqueIds),
          inArray(serviceInvoiceDocuments.documentTypeId, [
            SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_PDF,
            SERVICE_INVOICE_DOCUMENT_TYPE_INVOICE_PDF,
          ]),
          eq(serviceInvoiceDocuments.isActive, true),
        ),
      );

    const docsByInvoice = new Map<
      number,
      {
        annexure?: { s3Key: string; filename: string };
        invoice?: { s3Key: string; filename: string };
      }
    >();
    for (const doc of docRows) {
      const s3Key = doc.s3Key?.trim();
      if (!s3Key) continue;
      const entry = docsByInvoice.get(doc.serviceInvoiceId) ?? {};
      const filename =
        doc.fileName?.trim() ||
        (doc.documentTypeId === SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_PDF
          ? `annexure-${doc.serviceInvoiceId}.pdf`
          : `invoice-${doc.serviceInvoiceId}.pdf`);
      if (doc.documentTypeId === SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_PDF) {
        entry.annexure = { s3Key, filename };
      } else if (
        doc.documentTypeId === SERVICE_INVOICE_DOCUMENT_TYPE_INVOICE_PDF
      ) {
        entry.invoice = { s3Key, filename };
      }
      docsByInvoice.set(doc.serviceInvoiceId, entry);
    }

    type Ready = {
      id: number;
      input: Parameters<typeof enqueueEmails>[0][number];
    };
    const ready: Ready[] = [];
    const templateCc = SERVICE_INVOICE_EMAIL_CC?.trim() || null;
    const bcc = SERVICE_INVOICE_EMAIL_BCC?.trim() || null;

    for (const id of uniqueIds) {
      const invoice = byId.get(id);
      if (!invoice) {
        results.push({
          id,
          ok: false,
          error: ServiceInvoicesErrorMessages.NOT_FOUND,
        });
        continue;
      }

      if (invoice.status !== "generated") {
        results.push({
          id,
          ok: false,
          error: ServiceInvoicesErrorMessages.NOT_GENERATED,
        });
        continue;
      }

      const to = invoice.billingEmailTo?.trim() ?? "";
      if (!to) {
        results.push({
          id,
          ok: false,
          error: ServiceInvoicesErrorMessages.BILLING_EMAIL_MISSING,
        });
        continue;
      }

      const docs = docsByInvoice.get(id);
      const needsAnnexurePdf = serviceInvoiceRequiresAnnexurePdf(
        invoice.serviceFeeType,
      );
      if (!docs?.invoice) {
        results.push({
          id,
          ok: false,
          error: needsAnnexurePdf
            ? ServiceInvoicesErrorMessages.PDF_ATTACHMENT_MISSING
            : ServiceInvoicesErrorMessages.INVOICE_PDF_ATTACHMENT_MISSING,
        });
        continue;
      }
      if (needsAnnexurePdf && !docs.annexure) {
        results.push({
          id,
          ok: false,
          error: ServiceInvoicesErrorMessages.PDF_ATTACHMENT_MISSING,
        });
        continue;
      }

      const invoiceNumber =
        invoice.invoiceNumber?.trim() || `Service Invoice #${id}`;
      const invoiceMonthYear = formatMonthYearShort(invoice.toDate ?? "");
      const companyName = invoice.clientName?.trim() || "";
      const plantLocationName = invoice.plantLocationName?.trim() || "";
      const billingName = invoice.billingName?.trim() ?? "";
      const vars = {
        billingName,
        invoiceNumber,
        invoiceDate: formatDate(invoice.invoiceDate),
        amount: formatCurrency(invoice.grandTotal, { fractionDigits: 2 }),
        invoiceMonthYear,
        companyName,
        plantLocationName,
        includeAnnexureDetail: needsAnnexurePdf,
      };

      const attachments = [
        ...(needsAnnexurePdf && docs.annexure
          ? [
              {
                s3Key: docs.annexure.s3Key,
                filename: docs.annexure.filename,
                contentType: SI_PDF_CONTENT_TYPE,
              },
            ]
          : []),
        {
          s3Key: docs.invoice.s3Key,
          filename: docs.invoice.filename,
          contentType: SI_PDF_CONTENT_TYPE,
        },
      ];

      const billingCc = invoice.billingEmailCc?.trim() || null;
      const emailCc =
        [templateCc, billingCc].filter(Boolean).join(",") || null;

      ready.push({
        id,
        input: {
          notificationId: NOTIFICATION_TYPE_SERVICE_INVOICE_ANNEXURE,
          emailTo: to,
          emailCc,
          emailBcc: bcc,
          emailBody: buildServiceInvoiceEmailHtml(vars),
          subject: buildServiceInvoiceEmailSubject(vars),
          auctionId: null,
          requiresAttachment: true,
          sourceType: EMAIL_SOURCE_TYPE_SERVICE_INVOICE,
          sourceId: id,
          enqueuedBy: enqueuedBy ?? null,
          attachments,
        },
      });
    }

    if (ready.length > 0) {
      try {
        const { ids: emailLogIds } = await enqueueEmails(
          ready.map((r) => r.input),
        );
        for (let i = 0; i < ready.length; i += 1) {
          results.push({
            id: ready[i]!.id,
            ok: true,
            emailLogId: emailLogIds[i],
          });
        }
      } catch (e) {
        for (const item of ready) {
          results.push({
            id: item.id,
            ok: false,
            error:
              e instanceof Error
                ? e.message
                : ServiceInvoicesErrorMessages.BULK_SEND_FAILED,
          });
        }
      }
    }

    return {
      queued: results.filter((r) => r.ok).length,
      results,
    };
  },

  async sendEmail(
    id: number,
    enqueuedBy?: number | null,
  ): Promise<{ ok: true; emailLogId: number } | { ok: false; error: string }> {
    const { results } = await this.bulkSendEmail([id], enqueuedBy);
    const result = results[0];
    if (!result) {
      return { ok: false, error: ServiceInvoicesErrorMessages.NOT_FOUND };
    }
    if (!result.ok || result.emailLogId == null) {
      return {
        ok: false,
        error: result.error ?? ServiceInvoicesErrorMessages.SEND_FAILED,
      };
    }
    return { ok: true, emailLogId: result.emailLogId };
  },
};

async function uploadPdfForInvoice(
  id: number,
  kind: "annexure" | "invoice",
  file: { buffer: Buffer; originalname: string },
  userId: number | undefined,
): Promise<ServiceInvoiceListRow> {
  const existing = await serviceInvoicesService.get(id);
  if (!existing) throw new ServiceInvoiceNotFoundError();
  if (!ACCOUNTS_PDF_UPLOAD_STATUSES.has(existing.status)) {
    throw new ServiceInvoiceAccountsTransitionError();
  }

  const previousS3Key =
    kind === "annexure" ? existing.annexurePdfS3Key : existing.invoicePdfS3Key;
  const persisted = await persistServiceInvoicePdf({
    kind,
    invoiceId: id,
    clientId: existing.clientId,
    buffer: file.buffer,
    previousS3Key,
  });

  const now = formatUtcNow();
  await upsertServiceInvoiceDocument({
    serviceInvoiceId: id,
    documentTypeId:
      kind === "annexure"
        ? SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_PDF
        : SERVICE_INVOICE_DOCUMENT_TYPE_INVOICE_PDF,
    fileName: persisted.filename,
    s3Key: persisted.s3Key,
    userId: userId ?? null,
    at: now,
  });

  await db
    .update(serviceInvoices)
    .set({
      updatedAt: now,
      updatedBy: userId ?? null,
    })
    .where(eq(serviceInvoices.id, id));

  const updated = await serviceInvoicesService.get(id);
  if (!updated) throw new ServiceInvoiceNotFoundError();
  return updated;
}
