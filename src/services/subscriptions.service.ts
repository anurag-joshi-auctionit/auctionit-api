import {
  SubscriptionsErrorMessages,
  SubscriptionsValidationMessages,
} from "@auctionit/messages/subscriptions";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "../db/index.js";
import { bidders } from "../db/schema/bidders.js";
import {
  EMAIL_SOURCE_TYPE_SUBSCRIPTION,
  notificationEmailLogs,
} from "../db/schema/notification-email-logs.js";
import { paymentTypes } from "../db/schema/payment-types.js";
import { subscriptionDocuments } from "../db/schema/subscription-documents.js";
import {
  subscriptions,
  type SubscriptionInvoiceStatus,
} from "../db/schema/subscriptions.js";
import { subscriptionTypes } from "../db/schema/subscription-types.js";
import { users } from "../db/schema/users.js";
import { NOTIFICATION_TYPE_SUBSCRIPTION_ANNEXURE } from "../db/schema/notification-types.js";
import {
  SUBSCRIPTION_EXPORT_MAX_ROWS,
  SUBSCRIPTION_EXPORT_PAGE_SIZE,
} from "../lib/subscriptions/export-constants.js";
import {
  endOfTermMonth,
  firstOfCurrentMonthIST,
  isFromMonthOnOrAfterPaymentMonth,
  normalizeToFirst,
  periodFromPaymentDate,
  periodFromStartMonth,
} from "../lib/subscriptions/period.js";
import {
  persistSubscriptionInvoicePdf,
  signedSubscriptionInvoicePdfUrl,
} from "../lib/subscriptions/invoice-r2.js";
import { normalizeSubscriptionTransactionId } from "../lib/subscriptions/transaction-id.js";
import {
  canAccountsInvoiceTransition,
  canAdminInvoiceTransition,
  isAccountsUploadAllowed,
  isAdminEditableStatus,
  isCancelledInvoiceStatus,
} from "../lib/subscriptions/invoice-status-rules.js";
import { invoiceStatusStampFields } from "../lib/subscriptions/invoice-status-stamps.js";
import { SUBSCRIPTION_DOCUMENT_TYPE_INVOICE_PDF } from "../lib/subscriptions/subscription-document-naming.js";
import type { SubscriptionsExportParams } from "../lib/subscriptions/schemas.js";
import {
  buildSubscriptionEmailHtml,
  buildSubscriptionEmailSubject,
  SUBSCRIPTION_INVOICE_EMAIL_BCC,
  SUBSCRIPTION_INVOICE_EMAIL_CC,
} from "../lib/subscriptions/subscription-email-template.js";
import { formatCurrency } from "@auctionit/lib/currency";
import { formatDate, formatUtcNow } from "@auctionit/lib/date";
import { nextId } from "./_id.js";
import { clampPagination } from "./list-query.js";
import { enqueueEmails } from "./email-dispatch.service.js";

const SUBSCRIPTION_PDF_CONTENT_TYPE = "application/pdf";

type InvoicePdfDocRef = {
  fileName: string | null;
  s3Key: string | null;
};

async function invoicePdfDocsBySubscriptionIds(
  subscriptionIds: number[],
): Promise<Map<number, InvoicePdfDocRef>> {
  const result = new Map<number, InvoicePdfDocRef>();
  for (const id of subscriptionIds) {
    result.set(id, { fileName: null, s3Key: null });
  }
  if (subscriptionIds.length === 0) return result;

  const rows = await db
    .select({
      subscriptionId: subscriptionDocuments.subscriptionId,
      fileName: subscriptionDocuments.fileName,
      s3Key: subscriptionDocuments.s3Key,
    })
    .from(subscriptionDocuments)
    .where(
      and(
        inArray(subscriptionDocuments.subscriptionId, subscriptionIds),
        eq(
          subscriptionDocuments.documentTypeId,
          SUBSCRIPTION_DOCUMENT_TYPE_INVOICE_PDF,
        ),
        eq(subscriptionDocuments.isActive, true),
      ),
    );

  for (const row of rows) {
    result.set(row.subscriptionId, {
      fileName: row.fileName?.trim() || null,
      s3Key: row.s3Key?.trim() || null,
    });
  }
  return result;
}

/** Subscription ids with invoice email still queued or in-flight — hide email_sent_* until delivered. */
async function pendingSubscriptionEmailIds(
  subscriptionIds: number[],
): Promise<Set<number>> {
  const pending = new Set<number>();
  if (subscriptionIds.length === 0) return pending;

  const rows = await db
    .select({ sourceId: notificationEmailLogs.sourceId })
    .from(notificationEmailLogs)
    .where(
      and(
        eq(notificationEmailLogs.sourceType, EMAIL_SOURCE_TYPE_SUBSCRIPTION),
        eq(
          notificationEmailLogs.notificationId,
          NOTIFICATION_TYPE_SUBSCRIPTION_ANNEXURE,
        ),
        inArray(notificationEmailLogs.sourceId, subscriptionIds),
        inArray(notificationEmailLogs.status, ["queued", "sending"]),
      ),
    );

  for (const row of rows) {
    const id = row.sourceId;
    if (id != null && id > 0) pending.add(id);
  }
  return pending;
}

const subscriptionListRowSelect = {
  id: subscriptions.id,
  bidderId: subscriptions.bidderId,
  bidderName: bidders.companyName,
  subscriptionTypeId: subscriptions.subscriptionTypeId,
  subscriptionTypeName: subscriptionTypes.name,
  fromDate: subscriptions.fromDate,
  toDate: subscriptions.toDate,
  subscriptionPrice: subscriptions.subscriptionPrice,
  gstAmount: subscriptions.gstAmount,
  amount: subscriptions.amount,
  paymentMode: subscriptions.paymentMode,
  paymentModeName: paymentTypes.name,
  transactionId: subscriptions.transactionId,
  paymentDate: subscriptions.paymentDate,
  remarks: subscriptions.remarks,
  createdAt: subscriptions.createdAt,
  invoiceStatus: subscriptions.invoiceStatus,
  invoiceNumber: subscriptions.invoiceNumber,
  invoiceDate: subscriptions.invoiceDate,
  invoiceRequestedAt: subscriptions.invoiceRequestedAt,
  invoiceGeneratedAt: subscriptions.invoiceGeneratedAt,
  invoiceRecheckedAt: subscriptions.invoiceRecheckedAt,
  invoiceCancelledAt: subscriptions.invoiceCancelledAt,
  emailSentAt: subscriptions.emailSentAt,
  emailSentBy: subscriptions.emailSentBy,
  emailSentByName: users.name,
};

function subscriptionListFrom() {
  return db
    .select(subscriptionListRowSelect)
    .from(subscriptions)
    .leftJoin(bidders, eq(bidders.id, subscriptions.bidderId))
    .leftJoin(
      subscriptionTypes,
      eq(subscriptionTypes.id, subscriptions.subscriptionTypeId),
    )
    .leftJoin(paymentTypes, eq(paymentTypes.id, subscriptions.paymentMode))
    .leftJoin(users, eq(users.id, subscriptions.emailSentBy));
}

async function upsertSubscriptionDocument(opts: {
  subscriptionId: number;
  documentTypeId: number;
  fileName: string;
  s3Key: string;
  userId: number | null;
  at?: string;
}): Promise<void> {
  const at = opts.at ?? formatUtcNow();
  const [existing] = await db
    .select({ id: subscriptionDocuments.id })
    .from(subscriptionDocuments)
    .where(
      and(
        eq(subscriptionDocuments.subscriptionId, opts.subscriptionId),
        eq(subscriptionDocuments.documentTypeId, opts.documentTypeId),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(subscriptionDocuments)
      .set({
        fileName: opts.fileName,
        s3Key: opts.s3Key,
        isActive: true,
        updatedAt: at,
        updatedBy: opts.userId,
      })
      .where(eq(subscriptionDocuments.id, existing.id));
    return;
  }

  const id = await nextId("subscription_documents", "id");
  await db.insert(subscriptionDocuments).values({
    id,
    subscriptionId: opts.subscriptionId,
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

export class SubscriptionTypeNotFoundError extends Error {
  constructor(_id: number) {
    super(SubscriptionsErrorMessages.SUBSCRIPTION_TYPE_NOT_FOUND);
    this.name = "SubscriptionTypeNotFoundError";
  }
}

export class SubscriptionNotFoundError extends Error {
  constructor() {
    super(SubscriptionsErrorMessages.NOT_FOUND);
    this.name = "SubscriptionNotFoundError";
  }
}

export class SubscriptionLockedError extends Error {
  constructor() {
    super(SubscriptionsErrorMessages.LOCKED);
    this.name = "SubscriptionLockedError";
  }
}

export class SubscriptionValidationError extends Error {
  fieldErrors?: Record<string, string[]>;

  constructor(message: string, fieldErrors?: Record<string, string[]>) {
    super(message);
    this.name = "SubscriptionValidationError";
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

function isSubscriptionInvoiceNumberUniqueViolation(err: unknown): boolean {
  if (!isUniqueViolation(err)) return false;
  const constraint =
    typeof err === "object" &&
    err !== null &&
    "constraint" in err &&
    typeof (err as { constraint: unknown }).constraint === "string"
      ? (err as { constraint: string }).constraint
      : "";
  return (
    constraint.includes("subscriptions_invoice_number_uidx") ||
    constraint.includes("invoice_number")
  );
}

function duplicateSubscriptionInvoiceNumberError(): SubscriptionValidationError {
  const message = SubscriptionsValidationMessages.INVOICE_NUMBER_DUPLICATE;
  return new SubscriptionValidationError(message, {
    invoiceNumber: [message],
  });
}

async function assertSubscriptionInvoiceNumberAvailable(
  invoiceNumber: string,
  excludeId?: number,
): Promise<void> {
  if (!invoiceNumber) return;

  const conditions: SQL[] = [
    eq(subscriptions.invoiceNumber, invoiceNumber),
  ];
  if (excludeId != null) {
    conditions.push(ne(subscriptions.id, excludeId));
  }

  const rows = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(...conditions))
    .limit(1);

  if (rows[0]) {
    throw duplicateSubscriptionInvoiceNumberError();
  }
}

function duplicateSubscriptionTransactionIdError(): SubscriptionValidationError {
  const message = SubscriptionsValidationMessages.TRANSACTION_ID_DUPLICATE;
  return new SubscriptionValidationError(message, {
    transactionId: [message],
  });
}

async function assertSubscriptionTransactionIdAvailable(
  transactionId: string | null | undefined,
  excludeId?: number,
): Promise<void> {
  const normalized = transactionId
    ? normalizeSubscriptionTransactionId(transactionId)
    : "";
  if (!normalized) return;

  const conditions: SQL[] = [
    sql`lower(regexp_replace(coalesce(${subscriptions.transactionId}, ''), '\\s+', '', 'g')) = ${normalized}`,
  ];
  if (excludeId != null) {
    conditions.push(ne(subscriptions.id, excludeId));
  }

  const rows = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(...conditions))
    .limit(1);

  if (rows[0]) {
    throw duplicateSubscriptionTransactionIdError();
  }
}

function todayIST(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
  }).format(new Date());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function splitGst(
  gross: number,
  gstPercent: number,
): { subscriptionPrice: number; gstAmount: number } {
  if (!(gstPercent > 0)) return { subscriptionPrice: round2(gross), gstAmount: 0 };
  const price = (gross * 100) / (100 + gstPercent);
  return { subscriptionPrice: round2(price), gstAmount: round2(gross - price) };
}

function planMonths(plan: { id: number; months: number | null }): number {
  if (plan.months != null && plan.months > 0) return plan.months;
  throw new SubscriptionTypeNotFoundError(plan.id);
}

export type SubscriptionEntry = {
  id: number;
  bidderId: number;
  bidderName: string | null;
  subscriptionTypeId: number;
  subscriptionTypeName: string | null;
  fromDate: string | null;
  toDate: string | null;
  subscriptionPrice: number;
  gstAmount: number;
  amount: number;
  paymentMode: number | null;
  paymentModeName: string | null;
  transactionId: string | null;
  paymentDate: string | null;
  remarks: string | null;
  createdAt: string;
  invoiceStatus: SubscriptionInvoiceStatus;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  invoicePdfFilename: string | null;
  invoicePdfS3Key: string | null;
  invoicePdfUrl: string | null;
  invoiceRequestedAt: string | null;
  invoiceGeneratedAt: string | null;
  invoiceRecheckedAt: string | null;
  invoiceCancelledAt: string | null;
  emailSentAt: string | null;
  emailSentBy: number | null;
  emailSentByName: string | null;
};

export type SubscriptionStatus = {
  active: boolean;
  activeFrom: string | null;
  activeUntil: string | null;
  currentTypeName: string | null;
};

export type SubscriptionQuote = {
  subscriptionTypeId: number;
  name: string;
  amount: number;
  gstPercent: number;
  subscriptionPrice: number;
  gstAmount: number;
  fromDate: string;
  toDate: string | null;
};

export type SubscriptionsListParams = {
  page: number;
  pageSize: number;
  search?: string;
  sortBy?: "paymentDate" | "createdAt" | "amount" | "fromDate" | "toDate";
  sortOrder?: "asc" | "desc";
  dateField?: "paymentDate" | "fromDate" | "toDate" | "createdAt";
  dateFrom?: string;
  dateTo?: string;
  bidderId?: number;
  invoiceStatus?: SubscriptionInvoiceStatus;
  /** Only the latest payment row per bidder (payment_date DESC, id DESC). */
  latestPerBidder?: boolean;
};

export type SubscriptionBidderCohort = "subscribed" | "unsubscribed";

export type SubscriptionBidderRow = {
  bidderId: number;
  companyName: string;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
};

export type SubscriptionBiddersListParams = {
  cohort: SubscriptionBidderCohort;
  page: number;
  pageSize: number;
  search?: string;
  sortBy?: "companyName" | "bidderId";
  sortOrder?: "asc" | "desc";
};

function dateFilterConditions(params: {
  dateField?: "paymentDate" | "fromDate" | "toDate" | "createdAt";
  dateFrom?: string;
  dateTo?: string;
}): SQL[] {
  if (!params.dateField || (!params.dateFrom && !params.dateTo)) return [];
  const col =
    params.dateField === "fromDate"
      ? subscriptions.fromDate
      : params.dateField === "toDate"
        ? subscriptions.toDate
        : params.dateField === "createdAt"
          ? subscriptions.createdAt
          : subscriptions.paymentDate;
  const conditions: SQL[] = [];
  if (params.dateFrom) conditions.push(gte(col, params.dateFrom));
  if (params.dateTo) {
    if (params.dateField === "createdAt") {
      conditions.push(lte(col, `${params.dateTo}T23:59:59.999Z`));
    } else {
      conditions.push(lte(col, params.dateTo));
    }
  }
  return conditions;
}

function buildSubscriptionListConditions(params: {
  bidderId?: number;
  invoiceStatus?: SubscriptionInvoiceStatus;
  search?: string;
  dateField?: "paymentDate" | "fromDate" | "toDate" | "createdAt";
  dateFrom?: string;
  dateTo?: string;
}): SQL[] {
  const conditions: SQL[] = [];
  if (params.bidderId != null) {
    conditions.push(eq(subscriptions.bidderId, params.bidderId));
  }
  if (params.invoiceStatus) {
    conditions.push(eq(subscriptions.invoiceStatus, params.invoiceStatus));
  }
  if (params.search?.trim()) {
    const q = `%${params.search.trim()}%`;
    conditions.push(
      or(
        ilike(bidders.companyName, q),
        ilike(subscriptions.transactionId, q),
        ilike(subscriptions.remarks, q),
        ilike(subscriptions.invoiceNumber, q),
        sql`CAST(${subscriptions.bidderId} AS TEXT) ILIKE ${q}`,
        sql`CAST(${subscriptions.id} AS TEXT) ILIKE ${q}`,
      )!,
    );
  }
  conditions.push(...dateFilterConditions(params));
  return conditions;
}

/** Latest matching subscription id per bidder (payment_date, then id). */
function latestPerBidderIdSubquery(baseWhere: SQL | undefined) {
  return db
    .selectDistinctOn([subscriptions.bidderId], {
      id: subscriptions.id,
    })
    .from(subscriptions)
    .leftJoin(bidders, eq(bidders.id, subscriptions.bidderId))
    .where(baseWhere)
    .orderBy(
      subscriptions.bidderId,
      sql`${subscriptions.paymentDate} DESC NULLS LAST`,
      desc(subscriptions.id),
    );
}

export type SubscriptionPeriodStatsParams = {
  dateField?: "paymentDate" | "fromDate" | "toDate" | "createdAt";
  dateFrom?: string;
  dateTo?: string;
};

export type SubscriptionPeriodStats = {
  totalAmount: number;
  subscriberCount: number;
  requestedCount: number;
  recheckCount: number;
  generatedCount: number;
  cancelledCount: number;
};

export class SubscriptionsService {
  async getStatus(bidderId: number): Promise<SubscriptionStatus> {
    const rows = await db
      .select({
        fromDate: subscriptions.fromDate,
        toDate: subscriptions.toDate,
        invoiceStatus: subscriptions.invoiceStatus,
        subscriptionTypeName: subscriptionTypes.name,
      })
      .from(subscriptions)
      .leftJoin(
        subscriptionTypes,
        eq(subscriptionTypes.id, subscriptions.subscriptionTypeId),
      )
      .where(eq(subscriptions.bidderId, bidderId));

    return this.computeStatus(rows);
  }

  async listForBidder(
    bidderId: number,
    opts?: {
      page: number;
      pageSize: number;
      sortBy?: "paymentDate" | "createdAt" | "amount";
      sortOrder?: "asc" | "desc";
    },
  ): Promise<{
    items: SubscriptionEntry[];
    status: SubscriptionStatus;
    total: number;
    page: number;
    pageSize: number;
  }> {
    const result = await this.list({
      page: opts?.page ?? 1,
      pageSize: opts?.pageSize ?? 0,
      sortBy: opts?.sortBy,
      sortOrder: opts?.sortOrder,
      bidderId,
    });
    return {
      ...result,
      status: result.status ?? (await this.getStatus(bidderId)),
    };
  }

  async list(params: SubscriptionsListParams): Promise<{
    items: SubscriptionEntry[];
    status?: SubscriptionStatus;
    total: number;
    totalAmount: number;
    subscriberCount: number;
    page: number;
    pageSize: number;
  }> {
    const paginated = params.pageSize > 0;
    const { page, pageSize, offset } = paginated
      ? clampPagination(params.page, params.pageSize)
      : { page: 1, pageSize: 0, offset: 0 };

    const conditions = buildSubscriptionListConditions(params);
    const baseWhere =
      conditions.length > 0 ? and(...conditions) : undefined;
    const whereExpr = params.latestPerBidder
      ? and(
          inArray(subscriptions.id, latestPerBidderIdSubquery(baseWhere)),
        )
      : baseWhere;

    const descOrder = (params.sortOrder ?? "desc") === "desc";
    const sortBy = params.sortBy ?? "paymentDate";
    const primaryCol =
      sortBy === "createdAt"
        ? subscriptions.createdAt
        : sortBy === "amount"
          ? subscriptions.amount
          : sortBy === "fromDate"
            ? subscriptions.fromDate
            : sortBy === "toDate"
              ? subscriptions.toDate
              : subscriptions.paymentDate;
    const orderBy = descOrder
      ? [desc(primaryCol), desc(subscriptions.id)]
      : [asc(primaryCol), asc(subscriptions.id)];

    const [rows, [aggRow]] = await Promise.all([
      (() => {
        const q = subscriptionListFrom().where(whereExpr).orderBy(...orderBy);
        return paginated ? q.limit(pageSize).offset(offset) : q;
      })(),
      db
        .select({
          total: count(),
          totalAmount: sql<string>`coalesce(sum(${subscriptions.amount}), 0)`,
          subscriberCount: sql<string>`count(distinct ${subscriptions.bidderId})`,
        })
        .from(subscriptions)
        .leftJoin(bidders, eq(bidders.id, subscriptions.bidderId))
        .where(whereExpr),
    ]);

    const total = Number(aggRow?.total ?? 0);
    const docsById = await invoicePdfDocsBySubscriptionIds(
      rows.map((r) => r.id),
    );
    const pendingEmailIds = await pendingSubscriptionEmailIds(
      rows.map((r) => r.id),
    );
    const items: SubscriptionEntry[] = await Promise.all(
      rows.map((r) => {
        const doc = docsById.get(r.id) ?? { fileName: null, s3Key: null };
        return this.mapListRow(
          {
            ...r,
            invoicePdfFilename: doc.fileName,
            invoicePdfS3Key: doc.s3Key,
          },
          true,
          pendingEmailIds,
        );
      }),
    );

    const result: {
      items: SubscriptionEntry[];
      status?: SubscriptionStatus;
      total: number;
      totalAmount: number;
      subscriberCount: number;
      page: number;
      pageSize: number;
    } = {
      items,
      total,
      totalAmount: Number(aggRow?.totalAmount ?? 0),
      subscriberCount: Number(aggRow?.subscriberCount ?? 0),
      page: paginated ? page : 1,
      pageSize: paginated ? pageSize : total || 10,
    };

    if (params.bidderId != null) {
      result.status = await this.getStatus(params.bidderId);
    }

    return result;
  }

  async stats(
    params: SubscriptionPeriodStatsParams = {},
  ): Promise<SubscriptionPeriodStats> {
    const conditions = dateFilterConditions(params);
    const whereExpr = conditions.length > 0 ? and(...conditions) : undefined;

    const [row] = await db
      .select({
        totalAmount: sql<string>`coalesce(sum(${subscriptions.amount}), 0)`,
        subscriberCount: sql<string>`count(distinct ${subscriptions.bidderId})`,
        requestedCount: sql<string>`count(*) filter (where ${subscriptions.invoiceStatus} = 'requested')`,
        recheckCount: sql<string>`count(*) filter (where ${subscriptions.invoiceStatus} = 'recheck')`,
        generatedCount: sql<string>`count(*) filter (where ${subscriptions.invoiceStatus} = 'generated')`,
        cancelledCount: sql<string>`count(*) filter (where ${subscriptions.invoiceStatus} = 'cancelled')`,
      })
      .from(subscriptions)
      .where(whereExpr);

    return {
      totalAmount: Number(row?.totalAmount ?? 0),
      subscriberCount: Number(row?.subscriberCount ?? 0),
      requestedCount: Number(row?.requestedCount ?? 0),
      recheckCount: Number(row?.recheckCount ?? 0),
      generatedCount: Number(row?.generatedCount ?? 0),
      cancelledCount: Number(row?.cancelledCount ?? 0),
    };
  }

  async listBidders(params: SubscriptionBiddersListParams): Promise<{
    items: SubscriptionBidderRow[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const { page, pageSize, offset } = clampPagination(
      params.page,
      params.pageSize,
    );
    const today = todayIST();
    const hasCoveringSub = sql`EXISTS (
      SELECT 1 FROM ${subscriptions} s
      WHERE s.bidder_id = ${bidders.id}
        AND s.invoice_status <> 'cancelled'
        AND s.from_date IS NOT NULL
        AND s.to_date IS NOT NULL
        AND s.from_date <= ${today}
        AND s.to_date >= ${today}
    )`;
    const noCoveringSub = sql`NOT EXISTS (
      SELECT 1 FROM ${subscriptions} s
      WHERE s.bidder_id = ${bidders.id}
        AND s.invoice_status <> 'cancelled'
        AND s.from_date IS NOT NULL
        AND s.to_date IS NOT NULL
        AND s.from_date <= ${today}
        AND s.to_date >= ${today}
    )`;

    const conditions: SQL[] = [eq(bidders.isActive, true)];
    if (params.cohort === "subscribed") {
      conditions.push(hasCoveringSub);
    } else {
      conditions.push(noCoveringSub);
    }

    if (params.search?.trim()) {
      const q = `%${params.search.trim()}%`;
      conditions.push(
        or(
          ilike(bidders.companyName, q),
          sql`CAST(${bidders.id} AS TEXT) ILIKE ${q}`,
        )!,
      );
    }

    const whereExpr = and(...conditions);
    const descOrder = (params.sortOrder ?? "asc") === "desc";
    const sortBy = params.sortBy ?? "companyName";
    const primaryCol =
      sortBy === "bidderId" ? bidders.id : bidders.companyName;
    const orderBy = descOrder
      ? [desc(primaryCol), desc(bidders.id)]
      : [asc(primaryCol), asc(bidders.id)];

    const [rows, [countRow]] = await Promise.all([
      db
        .select({
          bidderId: bidders.id,
          companyName: bidders.companyName,
          address: bidders.address,
          city: bidders.city,
          state: bidders.state,
          country: bidders.country,
          contactPhone: users.phoneNumber,
          contactEmail: users.emailId,
        })
        .from(bidders)
        .leftJoin(users, eq(users.bidderId, bidders.id))
        .where(whereExpr)
        .orderBy(...orderBy)
        .limit(pageSize)
        .offset(offset),
      db.select({ total: count() }).from(bidders).where(whereExpr),
    ]);

    return {
      items: rows.map((r) => ({
        ...r,
        contactPhone: r.contactPhone ?? null,
        contactEmail: r.contactEmail ?? null,
      })),
      total: Number(countRow?.total ?? 0),
      page,
      pageSize,
    };
  }

  private computeStatus(
    items: Array<{
      fromDate?: string | null;
      toDate: string | null;
      invoiceStatus?: SubscriptionInvoiceStatus | null;
      subscriptionTypeName: string | null;
    }>,
  ): SubscriptionStatus {
    const today = todayIST();
    const active = items
      .filter(
        (i) =>
          !isCancelledInvoiceStatus(i.invoiceStatus ?? "requested") &&
          i.fromDate != null &&
          i.fromDate <= today &&
          i.toDate != null &&
          i.toDate >= today,
      )
      .sort((a, b) => (a.toDate! < b.toDate! ? 1 : -1))[0];
    if (active) {
      return {
        active: true,
        activeFrom: active.fromDate ?? null,
        activeUntil: active.toDate,
        currentTypeName: active.subscriptionTypeName,
      };
    }
    return {
      active: false,
      activeFrom: null,
      activeUntil: null,
      currentTypeName: null,
    };
  }

  /** Mirror derived cover onto bidder.validFrom / validTo from non-cancelled rows. */
  private async syncBidderValidity(bidderId: number): Promise<void> {
    const rows = await db
      .select({
        fromDate: subscriptions.fromDate,
        toDate: subscriptions.toDate,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.bidderId, bidderId),
          ne(subscriptions.invoiceStatus, "cancelled"),
        ),
      );

    const dated = rows.filter(
      (r): r is { fromDate: string; toDate: string } =>
        r.fromDate != null && r.toDate != null,
    );

    if (dated.length === 0) {
      await db
        .update(bidders)
        .set({ validFrom: null, validTo: null })
        .where(eq(bidders.id, bidderId));
      return;
    }

    let validFrom = dated[0]!.fromDate;
    let validTo = dated[0]!.toDate;
    for (const row of dated) {
      if (row.fromDate < validFrom) validFrom = row.fromDate;
      if (row.toDate > validTo) validTo = row.toDate;
    }

    await db
      .update(bidders)
      .set({ validFrom, validTo })
      .where(eq(bidders.id, bidderId));
  }

  async quote(
    subscriptionTypeId: number,
    fromDateInput?: string,
  ): Promise<SubscriptionQuote> {
    const plan = await this.getPlan(subscriptionTypeId);
    const gst = Number(plan.gstPercent);
    const amount = Number(plan.amount);
    const { subscriptionPrice, gstAmount } = splitGst(amount, gst);
    const months = planMonths(plan);
    const fromDate = fromDateInput
      ? normalizeToFirst(fromDateInput)
      : firstOfCurrentMonthIST();
    return {
      subscriptionTypeId: plan.id,
      name: plan.name,
      amount,
      gstPercent: gst,
      subscriptionPrice,
      gstAmount,
      fromDate,
      toDate: endOfTermMonth(fromDate, months),
    };
  }

  /** Bidder self-serve quote — period starts on the payment (today) month. */
  async quoteForBidder(
    bidderId: number,
    subscriptionTypeId: number,
  ): Promise<SubscriptionQuote> {
    void bidderId;
    const plan = await this.getPlan(subscriptionTypeId);
    const gst = Number(plan.gstPercent);
    const amount = Number(plan.amount);
    const { subscriptionPrice, gstAmount } = splitGst(amount, gst);
    const months = planMonths(plan);
    const { fromDate, toDate } = periodFromPaymentDate(todayIST(), months);
    return {
      subscriptionTypeId: plan.id,
      name: plan.name,
      amount,
      gstPercent: gst,
      subscriptionPrice,
      gstAmount,
      fromDate,
      toDate,
    };
  }

  async record(input: {
    bidderId: number;
    subscriptionTypeId: number;
    amount: number;
    paymentMode?: number | null;
    transactionId?: string | null;
    paymentDate: string;
    fromDate?: string | null;
    toDate?: string | null;
    remarks?: string | null;
    userId: number;
  }): Promise<{ id: number; alreadyActive: boolean }> {
    const plan = await this.getPlan(input.subscriptionTypeId);
    const gst = Number(plan.gstPercent);
    // Amount is always the plan total (client amount ignored).
    const amount = Number(plan.amount);
    const { subscriptionPrice, gstAmount } = splitGst(amount, gst);

    const months = planMonths(plan);
    const status = await this.getStatus(input.bidderId);
    const alreadyActive = status.active;

    // Admin may supply fromDate; portal online pay omits it → payment month.
    // toDate is always derived from plan months (client toDate ignored).
    const { fromDate, toDate } = input.fromDate?.trim()
      ? periodFromStartMonth(input.fromDate, months)
      : periodFromPaymentDate(input.paymentDate, months);

    if (!isFromMonthOnOrAfterPaymentMonth(fromDate, input.paymentDate)) {
      throw new SubscriptionValidationError(
        SubscriptionsValidationMessages.FROM_DATE_BEFORE_PAYMENT_MONTH,
        {
          fromDate: [
            SubscriptionsValidationMessages.FROM_DATE_BEFORE_PAYMENT_MONTH,
          ],
        },
      );
    }

    const now = formatUtcNow();

    await assertSubscriptionTransactionIdAvailable(input.transactionId);

    const [created] = await db
      .insert(subscriptions)
      .values({
        bidderId: input.bidderId,
        subscriptionTypeId: input.subscriptionTypeId,
        fromDate,
        toDate,
        subscriptionPrice: subscriptionPrice.toFixed(2),
        gstAmount: gstAmount.toFixed(2),
        amount: amount.toFixed(2),
        paymentMode: input.paymentMode ?? null,
        transactionId: input.transactionId?.trim() || null,
        paymentDate: input.paymentDate,
        remarks: input.remarks?.trim() || null,
        invoiceStatus: "requested",
        invoiceRequestedAt: now,
        invoiceRequestedBy: input.userId,
        createdBy: input.userId,
      })
      .returning({ id: subscriptions.id });

    await this.syncBidderValidity(input.bidderId);

    return { id: created!.id, alreadyActive };
  }

  async update(
    id: number,
    input: {
      subscriptionTypeId: number;
      amount: number;
      paymentMode?: number | null;
      transactionId?: string | null;
      paymentDate: string;
      fromDate?: string | null;
      toDate?: string | null;
      remarks?: string | null;
      status?: "requested";
      userId: number;
    },
  ): Promise<SubscriptionEntry> {
    const existing = await this.getById(id);
    if (!existing) throw new SubscriptionNotFoundError();
    if (!isAdminEditableStatus(existing.invoiceStatus)) {
      throw new SubscriptionLockedError();
    }

    const plan = await this.getPlan(input.subscriptionTypeId);
    const gst = Number(plan.gstPercent);
    // Amount is always the plan total (client amount ignored).
    const amount = Number(plan.amount);
    const { subscriptionPrice, gstAmount } = splitGst(amount, gst);
    const months = planMonths(plan);
    const { fromDate, toDate } = input.fromDate?.trim()
      ? periodFromStartMonth(input.fromDate, months)
      : periodFromPaymentDate(input.paymentDate, months);

    if (!isFromMonthOnOrAfterPaymentMonth(fromDate, input.paymentDate)) {
      throw new SubscriptionValidationError(
        SubscriptionsValidationMessages.FROM_DATE_BEFORE_PAYMENT_MONTH,
        {
          fromDate: [
            SubscriptionsValidationMessages.FROM_DATE_BEFORE_PAYMENT_MONTH,
          ],
        },
      );
    }

    await assertSubscriptionTransactionIdAvailable(input.transactionId, id);

    const now = formatUtcNow();
    const nextStatus = input.status ?? "requested";

    await db
      .update(subscriptions)
      .set({
        subscriptionTypeId: input.subscriptionTypeId,
        fromDate,
        toDate,
        subscriptionPrice: subscriptionPrice.toFixed(2),
        gstAmount: gstAmount.toFixed(2),
        amount: amount.toFixed(2),
        paymentMode: input.paymentMode ?? null,
        transactionId: input.transactionId?.trim() || null,
        paymentDate: input.paymentDate,
        remarks: input.remarks?.trim() || null,
        invoiceStatus: nextStatus,
        ...(nextStatus !== existing.invoiceStatus
          ? invoiceStatusStampFields(nextStatus, now, input.userId)
          : {}),
        updatedAt: now,
        updatedBy: input.userId,
      })
      .where(eq(subscriptions.id, id));

    await this.syncBidderValidity(existing.bidderId);

    const updated = await this.getById(id);
    if (!updated) throw new SubscriptionNotFoundError();
    return updated;
  }

  async getById(id: number): Promise<SubscriptionEntry | null> {
    const [row] = await subscriptionListFrom()
      .where(eq(subscriptions.id, id))
      .limit(1);

    if (!row) return null;
    const docsById = await invoicePdfDocsBySubscriptionIds([row.id]);
    const doc = docsById.get(row.id) ?? { fileName: null, s3Key: null };
    const pendingEmailIds = await pendingSubscriptionEmailIds([row.id]);
    return this.mapListRow(
      {
        ...row,
        invoicePdfFilename: doc.fileName,
        invoicePdfS3Key: doc.s3Key,
      },
      true,
      pendingEmailIds,
    );
  }

  async uploadInvoicePdf(
    id: number,
    file: { buffer: Buffer },
    meta: { invoiceNumber: string; invoiceDate: string },
    userId: number,
  ): Promise<SubscriptionEntry> {
    const existing = await this.getById(id);
    if (!existing) throw new SubscriptionNotFoundError();

    if (!isAccountsUploadAllowed(existing.invoiceStatus)) {
      throw new SubscriptionValidationError(
        SubscriptionsValidationMessages.UPLOAD_ONLY_REQUESTED,
      );
    }

    await assertSubscriptionInvoiceNumberAvailable(meta.invoiceNumber, id);

    const { s3Key, filename } = await persistSubscriptionInvoicePdf({
      subscriptionId: existing.id,
      bidderId: existing.bidderId,
      buffer: file.buffer,
      previousS3Key: existing.invoicePdfS3Key,
    });

    const now = formatUtcNow();
    await upsertSubscriptionDocument({
      subscriptionId: existing.id,
      documentTypeId: SUBSCRIPTION_DOCUMENT_TYPE_INVOICE_PDF,
      fileName: filename,
      s3Key,
      userId,
      at: now,
    });

    const alreadyGenerated = existing.invoiceStatus === "generated";

    try {
      await db
        .update(subscriptions)
        .set({
          invoiceNumber: meta.invoiceNumber,
          invoiceDate: meta.invoiceDate,
          ...(alreadyGenerated
            ? {}
            : {
                invoiceStatus: "generated" as const,
                invoiceGeneratedAt: now,
                invoiceGeneratedBy: userId,
              }),
          updatedAt: now,
          updatedBy: userId,
        })
        .where(eq(subscriptions.id, id));
    } catch (err) {
      if (isSubscriptionInvoiceNumberUniqueViolation(err)) {
        throw duplicateSubscriptionInvoiceNumberError();
      }
      throw err;
    }

    const updated = await this.getById(id);
    if (!updated) throw new SubscriptionNotFoundError();
    return updated;
  }

  async accountsUpdateInvoiceStatus(
    id: number,
    status: "recheck" | "cancelled",
    userId: number,
  ): Promise<SubscriptionEntry> {
    const existing = await this.getById(id);
    if (!existing) throw new SubscriptionNotFoundError();

    if (!canAccountsInvoiceTransition(existing.invoiceStatus, status)) {
      throw new SubscriptionValidationError(
        SubscriptionsValidationMessages.INVALID_ACCOUNTS_TRANSITION,
      );
    }

    const now = formatUtcNow();
    await db
      .update(subscriptions)
      .set({
        invoiceStatus: status,
        ...invoiceStatusStampFields(status, now, userId),
        updatedAt: now,
        updatedBy: userId,
      })
      .where(eq(subscriptions.id, id));

    if (status === "cancelled") {
      await this.syncBidderValidity(existing.bidderId);
    }

    const updated = await this.getById(id);
    if (!updated) throw new SubscriptionNotFoundError();
    return updated;
  }

  async adminUpdateInvoiceStatus(
    id: number,
    status: "requested",
    userId: number,
  ): Promise<SubscriptionEntry> {
    const existing = await this.getById(id);
    if (!existing) throw new SubscriptionNotFoundError();

    if (!canAdminInvoiceTransition(existing.invoiceStatus, status)) {
      throw new SubscriptionValidationError(
        SubscriptionsValidationMessages.INVALID_ADMIN_TRANSITION,
      );
    }

    const now = formatUtcNow();
    await db
      .update(subscriptions)
      .set({
        invoiceStatus: status,
        ...invoiceStatusStampFields(status, now, userId),
        updatedAt: now,
        updatedBy: userId,
      })
      .where(eq(subscriptions.id, id));

    const updated = await this.getById(id);
    if (!updated) throw new SubscriptionNotFoundError();
    return updated;
  }

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

    const rows = await db
      .select({
        id: subscriptions.id,
        invoiceStatus: subscriptions.invoiceStatus,
        invoiceNumber: subscriptions.invoiceNumber,
        invoiceDate: subscriptions.invoiceDate,
        amount: subscriptions.amount,
        bidderName: bidders.companyName,
        contactEmail: users.emailId,
        subscriptionTypeName: subscriptionTypes.name,
        invoicePdfS3Key: subscriptionDocuments.s3Key,
        invoicePdfFileName: subscriptionDocuments.fileName,
      })
      .from(subscriptions)
      .innerJoin(bidders, eq(bidders.id, subscriptions.bidderId))
      .leftJoin(
        users,
        and(eq(users.bidderId, bidders.id), eq(users.isActive, true)),
      )
      .leftJoin(
        subscriptionTypes,
        eq(subscriptionTypes.id, subscriptions.subscriptionTypeId),
      )
      .leftJoin(
        subscriptionDocuments,
        and(
          eq(subscriptionDocuments.subscriptionId, subscriptions.id),
          eq(
            subscriptionDocuments.documentTypeId,
            SUBSCRIPTION_DOCUMENT_TYPE_INVOICE_PDF,
          ),
          eq(subscriptionDocuments.isActive, true),
        ),
      )
      .where(inArray(subscriptions.id, uniqueIds));

    const byId = new Map(rows.map((r) => [r.id, r]));

    type Ready = {
      id: number;
      input: Parameters<typeof enqueueEmails>[0][number];
    };
    const ready: Ready[] = [];
    const cc = SUBSCRIPTION_INVOICE_EMAIL_CC?.trim() || null;
    const bcc = SUBSCRIPTION_INVOICE_EMAIL_BCC?.trim() || null;

    for (const id of uniqueIds) {
      const sub = byId.get(id);
      if (!sub) {
        results.push({
          id,
          ok: false,
          error: SubscriptionsErrorMessages.NOT_FOUND,
        });
        continue;
      }

      if (sub.invoiceStatus !== "generated") {
        results.push({
          id,
          ok: false,
          error: SubscriptionsErrorMessages.NOT_GENERATED,
        });
        continue;
      }

      const to = sub.contactEmail?.trim() ?? "";
      if (!to) {
        results.push({
          id,
          ok: false,
          error: SubscriptionsErrorMessages.BIDDER_EMAIL_MISSING,
        });
        continue;
      }

      const s3Key = sub.invoicePdfS3Key?.trim();
      if (!s3Key) {
        results.push({
          id,
          ok: false,
          error: SubscriptionsErrorMessages.INVOICE_PDF_MISSING,
        });
        continue;
      }

      const invoiceNumber =
        sub.invoiceNumber?.trim() || `Subscription Invoice #${id}`;
      const subscriptionTypeName =
        sub.subscriptionTypeName?.trim() || "subscription";
      const vars = {
        invoiceNumber,
        invoiceDate: formatDate(sub.invoiceDate),
        amount: formatCurrency(sub.amount, { fractionDigits: 2 }),
        subscriptionTypeName,
      };

      ready.push({
        id,
        input: {
          notificationId: NOTIFICATION_TYPE_SUBSCRIPTION_ANNEXURE,
          emailTo: to,
          emailCc: cc,
          emailBcc: bcc,
          emailBody: buildSubscriptionEmailHtml(vars),
          subject: buildSubscriptionEmailSubject(),
          auctionId: null,
          requiresAttachment: true,
          sourceType: EMAIL_SOURCE_TYPE_SUBSCRIPTION,
          sourceId: id,
          enqueuedBy: enqueuedBy ?? null,
          attachments: [
            {
              s3Key,
              filename:
                sub.invoicePdfFileName?.trim() ||
                `subscription-invoice-${id}.pdf`,
              contentType: SUBSCRIPTION_PDF_CONTENT_TYPE,
            },
          ],
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
                : SubscriptionsErrorMessages.BULK_SEND_FAILED,
          });
        }
      }
    }

    return {
      queued: results.filter((r) => r.ok).length,
      results,
    };
  }

  async sendEmail(
    id: number,
    enqueuedBy?: number | null,
  ): Promise<{ ok: true; emailLogId: number } | { ok: false; error: string }> {
    const { results } = await this.bulkSendEmail([id], enqueuedBy);
    const result = results[0];
    if (!result) {
      return { ok: false, error: SubscriptionsErrorMessages.NOT_FOUND };
    }
    if (!result.ok || result.emailLogId == null) {
      return {
        ok: false,
        error: result.error ?? SubscriptionsErrorMessages.SEND_FAILED,
      };
    }
    return { ok: true, emailLogId: result.emailLogId };
  }

  async listAllForExport(
    opts: SubscriptionsExportParams,
  ): Promise<SubscriptionEntry[]> {
    const ids = opts.ids ?? [];
    let whereExpr: SQL | undefined;
    if (ids.length > 0) {
      whereExpr = inArray(subscriptions.id, ids);
    } else {
      const conditions = buildSubscriptionListConditions({
        invoiceStatus: opts.invoiceStatus,
        search: opts.search,
        dateField: opts.dateField,
        dateFrom: opts.dateFrom,
        dateTo: opts.dateTo,
      });
      const baseWhere =
        conditions.length > 0 ? and(...conditions) : undefined;
      whereExpr = opts.latestPerBidder
        ? and(inArray(subscriptions.id, latestPerBidderIdSubquery(baseWhere)))
        : baseWhere;
    }
    const descOrder = (opts.sortOrder ?? "desc") === "desc";
    const sortBy = opts.sortBy ?? "paymentDate";
    const primaryCol =
      sortBy === "createdAt"
        ? subscriptions.createdAt
        : sortBy === "amount"
          ? subscriptions.amount
          : sortBy === "fromDate"
            ? subscriptions.fromDate
            : sortBy === "toDate"
              ? subscriptions.toDate
              : subscriptions.paymentDate;
    const orderBy = descOrder
      ? [desc(primaryCol), desc(subscriptions.id)]
      : [asc(primaryCol), asc(subscriptions.id)];

    const rows: SubscriptionEntry[] = [];
    let offset = 0;
    while (rows.length < SUBSCRIPTION_EXPORT_MAX_ROWS) {
      const take = Math.min(
        SUBSCRIPTION_EXPORT_PAGE_SIZE,
        SUBSCRIPTION_EXPORT_MAX_ROWS - rows.length,
      );
      const pageRows = await subscriptionListFrom()
        .where(whereExpr)
        .orderBy(...orderBy)
        .limit(take)
        .offset(offset);
      if (pageRows.length === 0) break;
      const docsById = await invoicePdfDocsBySubscriptionIds(
        pageRows.map((r) => r.id),
      );
      const pendingEmailIds = await pendingSubscriptionEmailIds(
        pageRows.map((r) => r.id),
      );
      for (const r of pageRows) {
        const doc = docsById.get(r.id) ?? { fileName: null, s3Key: null };
        rows.push(
          await this.mapListRow(
            {
              ...r,
              invoicePdfFilename: doc.fileName,
              invoicePdfS3Key: doc.s3Key,
            },
            false,
            pendingEmailIds,
          ),
        );
      }
      if (pageRows.length < take) break;
      offset += pageRows.length;
    }
    return rows;
  }

  private async mapListRow(
    r: {
      id: number;
      bidderId: number;
      bidderName: string | null;
      subscriptionTypeId: number;
      subscriptionTypeName: string | null;
      fromDate: string | null;
      toDate: string | null;
      subscriptionPrice: string;
      gstAmount: string;
      amount: string;
      paymentMode: number | null;
      paymentModeName: string | null;
      transactionId: string | null;
      paymentDate: string | null;
      remarks: string | null;
      createdAt: string;
      invoiceStatus: SubscriptionInvoiceStatus;
      invoiceNumber: string | null;
      invoiceDate: string | null;
      invoicePdfFilename: string | null;
      invoicePdfS3Key: string | null;
      invoiceRequestedAt: string | null;
      invoiceGeneratedAt: string | null;
      invoiceRecheckedAt: string | null;
      invoiceCancelledAt: string | null;
      emailSentAt: string | null;
      emailSentBy: number | null;
      emailSentByName: string | null;
    },
    withSignedUrl: boolean,
    pendingEmailIds: Set<number> = new Set(),
  ): Promise<SubscriptionEntry> {
    const emailPending = pendingEmailIds.has(r.id);
    return {
      id: r.id,
      bidderId: r.bidderId,
      bidderName: r.bidderName,
      subscriptionTypeId: r.subscriptionTypeId,
      subscriptionTypeName: r.subscriptionTypeName,
      fromDate: r.fromDate,
      toDate: r.toDate,
      subscriptionPrice: Number(r.subscriptionPrice),
      gstAmount: Number(r.gstAmount),
      amount: Number(r.amount),
      paymentMode: r.paymentMode,
      paymentModeName: r.paymentModeName,
      transactionId: r.transactionId,
      paymentDate: r.paymentDate,
      remarks: r.remarks,
      createdAt: r.createdAt,
      invoiceStatus: r.invoiceStatus,
      invoiceNumber: r.invoiceNumber,
      invoiceDate: r.invoiceDate,
      invoicePdfFilename: isCancelledInvoiceStatus(r.invoiceStatus)
        ? null
        : r.invoicePdfFilename,
      invoicePdfS3Key: isCancelledInvoiceStatus(r.invoiceStatus)
        ? null
        : r.invoicePdfS3Key,
      invoicePdfUrl:
        withSignedUrl &&
        r.invoicePdfS3Key &&
        !isCancelledInvoiceStatus(r.invoiceStatus)
          ? await signedSubscriptionInvoicePdfUrl(r.invoicePdfS3Key)
          : null,
      invoiceRequestedAt: r.invoiceRequestedAt,
      invoiceGeneratedAt: r.invoiceGeneratedAt,
      invoiceRecheckedAt: r.invoiceRecheckedAt,
      invoiceCancelledAt: r.invoiceCancelledAt,
      emailSentAt: emailPending ? null : r.emailSentAt,
      emailSentBy: emailPending ? null : r.emailSentBy,
      emailSentByName: emailPending ? null : r.emailSentByName,
    };
  }

  private async getPlan(id: number) {
    const [plan] = await db
      .select()
      .from(subscriptionTypes)
      .where(eq(subscriptionTypes.id, id))
      .limit(1);
    if (!plan) throw new SubscriptionTypeNotFoundError(id);
    return plan;
  }
}

export const subscriptionsService = new SubscriptionsService();

/** @deprecated Use subscriptionsService */
export const bidderSubscriptionsService = subscriptionsService;
