import { and, desc, eq } from "drizzle-orm";
import {
  ServiceInvoicesErrorMessages,
  ServiceInvoicesValidationMessages,
} from "@auctionit/messages/service-invoices";
import { db } from "../db/index.js";
import { serviceInvoicePaymentLogs } from "../db/schema/service-invoice-payment-logs.js";
import { syncPaymentAggregatesForInvoiceSql } from "../lib/service-invoices/payment-aggregates-sync.js";
import type { ServiceInvoicePaymentLogBody } from "../lib/service-invoices/schemas.js";
import { isValidIsoDateOnly } from "../lib/service-invoices/schemas.js";
import { nextId } from "./_id.js";
import {
  ServiceInvoiceNotFoundError,
  serviceInvoicesService,
  type ServiceInvoiceListRow,
} from "./service-invoices.service.js";
import { datetimeLocalToIso, formatUtcNow } from "@auctionit/lib/date";

export type ServiceInvoicePaymentLogRow = {
  id: number;
  serviceInvoiceId: number;
  paidAmount: number;
  paidAt: string;
  createdAt: string | null;
  createdBy: number | null;
  updatedAt: string | null;
  updatedBy: number | null;
};

export class ServiceInvoicePaymentLogNotFoundError extends Error {
  constructor() {
    super(ServiceInvoicesErrorMessages.PAYMENT_LOG_NOT_FOUND);
    this.name = "ServiceInvoicePaymentLogNotFoundError";
  }
}

export class ServiceInvoicePaymentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceInvoicePaymentValidationError";
  }
}

function num(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Normalize date-only or ISO datetime to naive IST wall-clock for storage. */
export function normalizePaidAt(value: string): string {
  const trimmed = value.trim();
  if (isValidIsoDateOnly(trimmed)) {
    return `${trimmed}T00:00:00`;
  }
  return (
    datetimeLocalToIso(trimmed) ?? formatUtcNow(new Date(trimmed))
  );
}

function mapLog(r: {
  id: number;
  serviceInvoiceId: number;
  paidAmount: string;
  paidAt: string;
  createdAt: string | null;
  createdBy: number | null;
  updatedAt: string | null;
  updatedBy: number | null;
}): ServiceInvoicePaymentLogRow {
  return {
    id: r.id,
    serviceInvoiceId: r.serviceInvoiceId,
    paidAmount: num(r.paidAmount),
    paidAt: r.paidAt,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
  };
}

async function assertGeneratedInvoice(
  invoiceId: number,
): Promise<ServiceInvoiceListRow> {
  const invoice = await serviceInvoicesService.get(invoiceId);
  if (!invoice) throw new ServiceInvoiceNotFoundError();
  if (invoice.status !== "generated") {
    throw new ServiceInvoicePaymentValidationError(
      ServiceInvoicesValidationMessages.PAYMENT_ONLY_GENERATED,
    );
  }
  return invoice;
}

export async function sumActivePaidAmount(
  invoiceId: number,
  excludeLogId?: number,
): Promise<number> {
  const rows = await db
    .select({
      paidAmount: serviceInvoicePaymentLogs.paidAmount,
      id: serviceInvoicePaymentLogs.id,
    })
    .from(serviceInvoicePaymentLogs)
    .where(
      and(
        eq(serviceInvoicePaymentLogs.serviceInvoiceId, invoiceId),
        eq(serviceInvoicePaymentLogs.isActive, true),
      ),
    );

  let sum = 0;
  for (const row of rows) {
    if (excludeLogId != null && row.id === excludeLogId) continue;
    sum += num(row.paidAmount);
  }
  return sum;
}

export async function assertPaymentWithinGrandTotal(
  invoiceId: number,
  grandTotal: number,
  nextPaidAmount: number,
  excludeLogId?: number,
): Promise<void> {
  const otherSum = await sumActivePaidAmount(invoiceId, excludeLogId);
  const proposed = Number((otherSum + nextPaidAmount).toFixed(3));
  const capped = Number(grandTotal.toFixed(3));
  if (proposed > capped) {
    throw new ServiceInvoicePaymentValidationError(
      ServiceInvoicesValidationMessages.PAYMENT_EXCEEDS_GRAND_TOTAL,
    );
  }
}

/**
 * Inserts a payment log and syncs invoice aggregates.
 * Caller must ensure invoice is generated and amount is within grand total.
 */
export async function insertPaymentLog(
  invoiceId: number,
  input: ServiceInvoicePaymentLogBody,
  userId: number | undefined,
): Promise<ServiceInvoicePaymentLogRow> {
  const id = await nextId("service_invoice_payment_logs", "id");
  const now = formatUtcNow();
  const paidAt = normalizePaidAt(input.paidAt);

  await db.insert(serviceInvoicePaymentLogs).values({
    id,
    serviceInvoiceId: invoiceId,
    paidAmount: input.paidAmount.toFixed(3),
    paidAt,
    isActive: true,
    createdAt: now,
    createdBy: userId ?? null,
    updatedAt: null,
    updatedBy: null,
  });

  await db.execute(syncPaymentAggregatesForInvoiceSql(invoiceId));

  const [logRow] = await db
    .select({
      id: serviceInvoicePaymentLogs.id,
      serviceInvoiceId: serviceInvoicePaymentLogs.serviceInvoiceId,
      paidAmount: serviceInvoicePaymentLogs.paidAmount,
      paidAt: serviceInvoicePaymentLogs.paidAt,
      createdAt: serviceInvoicePaymentLogs.createdAt,
      createdBy: serviceInvoicePaymentLogs.createdBy,
      updatedAt: serviceInvoicePaymentLogs.updatedAt,
      updatedBy: serviceInvoicePaymentLogs.updatedBy,
    })
    .from(serviceInvoicePaymentLogs)
    .where(eq(serviceInvoicePaymentLogs.id, id))
    .limit(1);

  if (!logRow) throw new ServiceInvoiceNotFoundError();
  return mapLog(logRow);
}

export const serviceInvoicePaymentLogsService = {
  async list(invoiceId: number): Promise<ServiceInvoicePaymentLogRow[]> {
    const invoice = await serviceInvoicesService.get(invoiceId);
    if (!invoice) throw new ServiceInvoiceNotFoundError();

    const rows = await db
      .select({
        id: serviceInvoicePaymentLogs.id,
        serviceInvoiceId: serviceInvoicePaymentLogs.serviceInvoiceId,
        paidAmount: serviceInvoicePaymentLogs.paidAmount,
        paidAt: serviceInvoicePaymentLogs.paidAt,
        createdAt: serviceInvoicePaymentLogs.createdAt,
        createdBy: serviceInvoicePaymentLogs.createdBy,
        updatedAt: serviceInvoicePaymentLogs.updatedAt,
        updatedBy: serviceInvoicePaymentLogs.updatedBy,
      })
      .from(serviceInvoicePaymentLogs)
      .where(
        and(
          eq(serviceInvoicePaymentLogs.serviceInvoiceId, invoiceId),
          eq(serviceInvoicePaymentLogs.isActive, true),
        ),
      )
      .orderBy(
        desc(serviceInvoicePaymentLogs.paidAt),
        desc(serviceInvoicePaymentLogs.id),
      );

    return rows.map(mapLog);
  },

  async create(
    invoiceId: number,
    input: ServiceInvoicePaymentLogBody,
    userId: number | undefined,
  ): Promise<{ log: ServiceInvoicePaymentLogRow; invoice: ServiceInvoiceListRow }> {
    const invoice = await assertGeneratedInvoice(invoiceId);
    await assertPaymentWithinGrandTotal(
      invoiceId,
      invoice.grandTotal,
      input.paidAmount,
    );

    const log = await insertPaymentLog(invoiceId, input, userId);

    const updatedInvoice = await serviceInvoicesService.get(invoiceId);
    if (!updatedInvoice) throw new ServiceInvoiceNotFoundError();

    return { log, invoice: updatedInvoice };
  },

  async update(
    invoiceId: number,
    logId: number,
    input: ServiceInvoicePaymentLogBody,
    userId: number | undefined,
  ): Promise<{ log: ServiceInvoicePaymentLogRow; invoice: ServiceInvoiceListRow }> {
    const invoice = await assertGeneratedInvoice(invoiceId);

    const [existing] = await db
      .select({
        id: serviceInvoicePaymentLogs.id,
        serviceInvoiceId: serviceInvoicePaymentLogs.serviceInvoiceId,
        isActive: serviceInvoicePaymentLogs.isActive,
      })
      .from(serviceInvoicePaymentLogs)
      .where(
        and(
          eq(serviceInvoicePaymentLogs.id, logId),
          eq(serviceInvoicePaymentLogs.serviceInvoiceId, invoiceId),
          eq(serviceInvoicePaymentLogs.isActive, true),
        ),
      )
      .limit(1);

    if (!existing) throw new ServiceInvoicePaymentLogNotFoundError();

    await assertPaymentWithinGrandTotal(
      invoiceId,
      invoice.grandTotal,
      input.paidAmount,
      logId,
    );

    const now = formatUtcNow();
    const paidAt = normalizePaidAt(input.paidAt);

    await db
      .update(serviceInvoicePaymentLogs)
      .set({
        paidAmount: input.paidAmount.toFixed(3),
        paidAt,
        updatedAt: now,
        updatedBy: userId ?? null,
      })
      .where(eq(serviceInvoicePaymentLogs.id, logId));

    await db.execute(syncPaymentAggregatesForInvoiceSql(invoiceId));

    const [logRow] = await db
      .select({
        id: serviceInvoicePaymentLogs.id,
        serviceInvoiceId: serviceInvoicePaymentLogs.serviceInvoiceId,
        paidAmount: serviceInvoicePaymentLogs.paidAmount,
        paidAt: serviceInvoicePaymentLogs.paidAt,
        createdAt: serviceInvoicePaymentLogs.createdAt,
        createdBy: serviceInvoicePaymentLogs.createdBy,
        updatedAt: serviceInvoicePaymentLogs.updatedAt,
        updatedBy: serviceInvoicePaymentLogs.updatedBy,
      })
      .from(serviceInvoicePaymentLogs)
      .where(eq(serviceInvoicePaymentLogs.id, logId))
      .limit(1);

    const updatedInvoice = await serviceInvoicesService.get(invoiceId);
    if (!logRow || !updatedInvoice) throw new ServiceInvoiceNotFoundError();

    return { log: mapLog(logRow), invoice: updatedInvoice };
  },
};
