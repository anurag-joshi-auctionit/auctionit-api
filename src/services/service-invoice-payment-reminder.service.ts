import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  EMAIL_SOURCE_TYPE_SERVICE_INVOICE,
  notificationEmailLogs,
} from "../db/schema/notification-email-logs.js";
import {
  NOTIFICATION_TYPE_SI_PAYMENT_REMINDER_AFTER_DUE,
  NOTIFICATION_TYPE_SI_PAYMENT_REMINDER_BEFORE_DUE,
} from "../db/schema/notification-types.js";
import { plantLocations } from "../db/schema/plant-locations.js";
import { serviceInvoices } from "../db/schema/service-invoices.js";
import { addDaysToDateOnly } from "../lib/service-invoices/date-only.js";
import { formatCurrency } from "@auctionit/lib/currency";
import { formatDate } from "@auctionit/lib/date";
import {
  buildServiceInvoicePaymentReminderAfterDueHtml,
  buildServiceInvoicePaymentReminderAfterDueSubject,
  SERVICE_INVOICE_PAYMENT_REMINDER_AFTER_DUE_BCC,
} from "../lib/service-invoices/service-invoice-payment-reminder-after-due-email-template.js";
import {
  buildServiceInvoicePaymentReminderBeforeDueHtml,
  buildServiceInvoicePaymentReminderBeforeDueSubject,
  SERVICE_INVOICE_PAYMENT_REMINDER_BEFORE_DUE_BCC,
} from "../lib/service-invoices/service-invoice-payment-reminder-before-due-email-template.js";
import { enqueueEmails, type EnqueueEmailInput } from "./email-dispatch.service.js";

/** Legacy day offsets before PaymentDueDate_Manual (NotificationId 90). */
export const SI_PAYMENT_REMINDER_BEFORE_DUE_OFFSETS = [5, 2, 1] as const;
/** Legacy day offsets after PaymentDueDate_Manual (NotificationId 91). */
export const SI_PAYMENT_REMINDER_AFTER_DUE_OFFSETS = [1, 3] as const;
/** Legacy DATEPART(hour) >= 10 gate. */
export const SI_PAYMENT_REMINDER_HOUR_GATE = 10;
/** Legacy ClientId <> 9. */
export const SI_PAYMENT_REMINDER_EXCLUDED_CLIENT_ID = 9;

const DEDUPE_STATUSES = ["queued", "sending", "sent"] as const;

/** @deprecated Prefer `formatDate` from `@auctionit/lib/date`. */
export const formatPaymentDueDateDdMmmYyyy = formatDate;

export type IstCalendarParts = {
  hour: number;
  /** YYYY-MM-DD in Asia/Kolkata. */
  dateOnly: string;
};

/** Calendar day + hour in Asia/Kolkata (legacy server was IST). */
export function getIstCalendarParts(now: Date): IstCalendarParts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const lookup = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const hourRaw = lookup("hour");
  // en-GB hourCycle can yield "24" at midnight — normalize to 0.
  const hour = hourRaw === "24" ? 0 : Number(hourRaw);
  return {
    hour: Number.isFinite(hour) ? hour : 0,
    dateOnly: `${lookup("year")}-${lookup("month")}-${lookup("day")}`,
  };
}

export function dueDatesForBeforeReminders(today: string): string[] {
  return SI_PAYMENT_REMINDER_BEFORE_DUE_OFFSETS.map((offset) =>
    addDaysToDateOnly(today, offset),
  ).filter((d): d is string => d != null);
}

export function dueDatesForAfterReminders(today: string): string[] {
  return SI_PAYMENT_REMINDER_AFTER_DUE_OFFSETS.map((offset) =>
    addDaysToDateOnly(today, -offset),
  ).filter((d): d is string => d != null);
}

export type ReminderEligibilityInput = {
  paymentDueDate: string | null | undefined;
  emailSentAt: string | null | undefined;
  paymentStatus: string | null | undefined;
  clientId: number;
  status: string | null | undefined;
  billingEmailTo: string | null | undefined;
};

/** Shared filters for both 90 and 91 (excluding day-offset match). */
export function isEligibleForPaymentReminder(
  row: ReminderEligibilityInput,
): boolean {
  if (row.status !== "generated") return false;
  if (!row.paymentDueDate?.trim()) return false;
  if (!row.emailSentAt) return false;
  if (row.paymentStatus === "paid") return false;
  if (row.clientId === SI_PAYMENT_REMINDER_EXCLUDED_CLIENT_ID) return false;
  if (!row.billingEmailTo?.trim()) return false;
  return true;
}

type CandidateRow = {
  id: number;
  invoiceNumber: string | null;
  grandTotal: string;
  paymentDueDate: string | null;
  emailSentAt: string | null;
  paymentStatus: string;
  clientId: number;
  status: string;
  billingEmailTo: string | null;
  billingEmailCc: string | null;
};

async function loadCandidates(dueDates: string[]): Promise<CandidateRow[]> {
  if (dueDates.length === 0) return [];
  return db
    .select({
      id: serviceInvoices.id,
      invoiceNumber: serviceInvoices.invoiceNumber,
      grandTotal: serviceInvoices.grandTotal,
      paymentDueDate: serviceInvoices.paymentDueDate,
      emailSentAt: serviceInvoices.emailSentAt,
      paymentStatus: serviceInvoices.paymentStatus,
      clientId: serviceInvoices.clientId,
      status: serviceInvoices.status,
      billingEmailTo: plantLocations.billingEmailTo,
      billingEmailCc: plantLocations.billingEmailCc,
    })
    .from(serviceInvoices)
    .innerJoin(
      plantLocations,
      eq(serviceInvoices.plantLocationId, plantLocations.id),
    )
    .where(
      and(
        eq(serviceInvoices.status, "generated"),
        isNotNull(serviceInvoices.paymentDueDate),
        isNotNull(serviceInvoices.emailSentAt),
        ne(serviceInvoices.paymentStatus, "paid"),
        ne(serviceInvoices.clientId, SI_PAYMENT_REMINDER_EXCLUDED_CLIENT_ID),
        inArray(serviceInvoices.paymentDueDate, dueDates),
      ),
    );
}

async function alreadyTriedToday(
  notificationId: number,
  sourceIds: number[],
  todayIst: string,
): Promise<Set<number>> {
  if (sourceIds.length === 0) return new Set();
  const rows = await db
    .select({ sourceId: notificationEmailLogs.sourceId })
    .from(notificationEmailLogs)
    .where(
      and(
        eq(notificationEmailLogs.notificationId, notificationId),
        eq(notificationEmailLogs.sourceType, EMAIL_SOURCE_TYPE_SERVICE_INVOICE),
        inArray(notificationEmailLogs.sourceId, sourceIds),
        inArray(notificationEmailLogs.status, [...DEDUPE_STATUSES]),
        sql`(${notificationEmailLogs.createdAt} AT TIME ZONE 'Asia/Kolkata')::date = CAST(${todayIst} AS date)`,
      ),
    );
  return new Set(
    rows
      .map((r) => r.sourceId)
      .filter((id): id is number => id != null && Number.isInteger(id)),
  );
}

function buildEnqueueInput(
  row: CandidateRow,
  kind: "before" | "after",
): EnqueueEmailInput | null {
  if (
    !isEligibleForPaymentReminder({
      paymentDueDate: row.paymentDueDate,
      emailSentAt: row.emailSentAt,
      paymentStatus: row.paymentStatus,
      clientId: row.clientId,
      status: row.status,
      billingEmailTo: row.billingEmailTo,
    })
  ) {
    return null;
  }

  const invoiceNumber = row.invoiceNumber?.trim() || String(row.id);
  const vars = {
    invoiceNumber,
    amount: formatCurrency(row.grandTotal, { fractionDigits: 2 }),
    paymentDueDate: formatDate(row.paymentDueDate),
  };

  const subject =
    kind === "before"
      ? buildServiceInvoicePaymentReminderBeforeDueSubject(vars)
      : buildServiceInvoicePaymentReminderAfterDueSubject(vars);
  const emailBody =
    kind === "before"
      ? buildServiceInvoicePaymentReminderBeforeDueHtml(vars)
      : buildServiceInvoicePaymentReminderAfterDueHtml(vars);
  const bcc =
    kind === "before"
      ? SERVICE_INVOICE_PAYMENT_REMINDER_BEFORE_DUE_BCC?.trim() || null
      : SERVICE_INVOICE_PAYMENT_REMINDER_AFTER_DUE_BCC?.trim() || null;

  return {
    notificationId:
      kind === "before"
        ? NOTIFICATION_TYPE_SI_PAYMENT_REMINDER_BEFORE_DUE
        : NOTIFICATION_TYPE_SI_PAYMENT_REMINDER_AFTER_DUE,
    emailTo: row.billingEmailTo!.trim(),
    emailCc: row.billingEmailCc?.trim() || null,
    emailBcc: bcc,
    emailBody,
    subject,
    requiresAttachment: false,
    sourceType: EMAIL_SOURCE_TYPE_SERVICE_INVOICE,
    sourceId: row.id,
    enqueuedBy: null,
  };
}

/**
 * Enqueue payment reminder emails for invoices due in 5/2/1 days (90)
 * or overdue by 1/3 days (91). No-op before 10:00 Asia/Kolkata.
 */
export async function enqueueDueReminders(
  now: Date = new Date(),
): Promise<{ before: number; after: number }> {
  const { hour, dateOnly: today } = getIstCalendarParts(now);
  if (hour < SI_PAYMENT_REMINDER_HOUR_GATE) {
    return { before: 0, after: 0 };
  }

  const beforeDueDates = dueDatesForBeforeReminders(today);
  const afterDueDates = dueDatesForAfterReminders(today);

  const [beforeCandidates, afterCandidates] = await Promise.all([
    loadCandidates(beforeDueDates),
    loadCandidates(afterDueDates),
  ]);

  const beforeIds = beforeCandidates.map((r) => r.id);
  const afterIds = afterCandidates.map((r) => r.id);
  const [beforeTried, afterTried] = await Promise.all([
    alreadyTriedToday(
      NOTIFICATION_TYPE_SI_PAYMENT_REMINDER_BEFORE_DUE,
      beforeIds,
      today,
    ),
    alreadyTriedToday(
      NOTIFICATION_TYPE_SI_PAYMENT_REMINDER_AFTER_DUE,
      afterIds,
      today,
    ),
  ]);

  const inputs: EnqueueEmailInput[] = [];
  for (const row of beforeCandidates) {
    if (beforeTried.has(row.id)) continue;
    const input = buildEnqueueInput(row, "before");
    if (input) inputs.push(input);
  }
  for (const row of afterCandidates) {
    if (afterTried.has(row.id)) continue;
    const input = buildEnqueueInput(row, "after");
    if (input) inputs.push(input);
  }

  if (inputs.length === 0) return { before: 0, after: 0 };

  await enqueueEmails(inputs);

  const before = inputs.filter(
    (i) => i.notificationId === NOTIFICATION_TYPE_SI_PAYMENT_REMINDER_BEFORE_DUE,
  ).length;
  const after = inputs.filter(
    (i) => i.notificationId === NOTIFICATION_TYPE_SI_PAYMENT_REMINDER_AFTER_DUE,
  ).length;
  return { before, after };
}
