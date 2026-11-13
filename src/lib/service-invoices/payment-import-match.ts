/** Which field failed the invoice ID / invoice number pair check. */
export function paymentImportInvoicePairIssue(input: {
  invoiceFound: boolean;
  numberMatches: boolean;
}): "id-not-found" | "combo" | null {
  if (!input.invoiceFound) {
    return "id-not-found";
  }
  if (input.numberMatches) return null;
  return "combo";
}
