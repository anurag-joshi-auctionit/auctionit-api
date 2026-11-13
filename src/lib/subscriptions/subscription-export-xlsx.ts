import { SubscriptionInvoiceStatusLabels } from "@auctionit/messages/subscriptions";
import { buildRowsXlsx, type ExportColumn } from "@auctionit/xlsx-export";
import type { SubscriptionEntry } from "../../services/subscriptions.service.js";

function str(v: string | number | null | undefined): string {
  if (v == null) return "";
  return String(v);
}

const EXPORT_COLUMNS: ExportColumn<SubscriptionEntry>[] = [
  { header: "Subscription ID", width: 14, value: (r) => r.id },
  { header: "Bidder", width: 28, value: (r) => r.bidderName ?? "" },
  { header: "Bidder ID", width: 12, value: (r) => r.bidderId },
  {
    header: "Subscription Type",
    width: 18,
    value: (r) => r.subscriptionTypeName ?? "",
  },
  { header: "Payment Date", width: 14, value: (r) => r.paymentDate ?? "" },
  { header: "Payment Mode", width: 16, value: (r) => r.paymentModeName ?? "" },
  {
    header: "Transaction Reference No.",
    width: 20,
    value: (r) => r.transactionId ?? "",
  },
  { header: "Amount", width: 14, value: (r) => r.amount },
  { header: "From", width: 14, value: (r) => r.fromDate ?? "" },
  { header: "To", width: 14, value: (r) => r.toDate ?? "" },
  { header: "Remarks", width: 28, value: (r) => r.remarks ?? "" },
  {
    header: "Status",
    width: 14,
    value: (r) =>
      SubscriptionInvoiceStatusLabels[r.invoiceStatus] ?? r.invoiceStatus,
  },
  { header: "Invoice Number", width: 16, value: (r) => r.invoiceNumber ?? "" },
  { header: "Invoice Date", width: 14, value: (r) => r.invoiceDate ?? "" },
  {
    header: "Invoice PDF",
    width: 28,
    value: (r) => r.invoicePdfFilename ?? "",
  },
  {
    header: "Requested At",
    width: 20,
    value: (r) => str(r.invoiceRequestedAt),
  },
  {
    header: "Generated At",
    width: 20,
    value: (r) => str(r.invoiceGeneratedAt),
  },
  {
    header: "Emailed At",
    width: 20,
    value: (r) => str(r.emailSentAt),
  },
  {
    header: "Rechecked At",
    width: 20,
    value: (r) => str(r.invoiceRecheckedAt),
  },
  {
    header: "Cancelled At",
    width: 20,
    value: (r) => str(r.invoiceCancelledAt),
  },
];

export function buildSubscriptionsExportFilename(): string {
  return "subscriptions-export.xlsx";
}

export async function buildSubscriptionsExportXlsx(
  rows: SubscriptionEntry[],
): Promise<Buffer> {
  return buildRowsXlsx({
    sheetName: "Subscriptions",
    creator: "AuctionIT",
    columns: EXPORT_COLUMNS,
    rows,
  });
}
