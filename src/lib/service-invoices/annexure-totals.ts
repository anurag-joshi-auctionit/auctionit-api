import type {
  ServiceInvoiceAnnexureLine,
  ServiceInvoiceAnnexureTotals,
} from "./annexure-types.js";

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function aggregateAnnexureTotals(
  lines: ServiceInvoiceAnnexureLine[],
): ServiceInvoiceAnnexureTotals {
  let totalQuantity = 0;
  let totalAmount = 0;
  for (const line of lines) {
    totalQuantity += line.liftedQty;
    totalAmount += line.amount;
  }
  return {
    totalQuantity: round3(totalQuantity),
    totalAmount: round3(totalAmount),
  };
}
