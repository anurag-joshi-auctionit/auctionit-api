export const SUBSCRIPTION_DOCUMENT_TYPE_INVOICE_PDF = 1;

export const SUBSCRIPTION_DOCUMENT_TYPE_IDS = [
  SUBSCRIPTION_DOCUMENT_TYPE_INVOICE_PDF,
] as const;

export type SubscriptionDocumentTypeId =
  (typeof SUBSCRIPTION_DOCUMENT_TYPE_IDS)[number];

export const LEGACY_SUBSCRIPTION_DOCUMENT_TYPE_PREFIXES: Record<
  number,
  string
> = {
  [SUBSCRIPTION_DOCUMENT_TYPE_INVOICE_PDF]: "invoice_pdf_",
};

export const SUBSCRIPTION_DOCUMENT_TYPE_NAMES: Record<number, string> = {
  [SUBSCRIPTION_DOCUMENT_TYPE_INVOICE_PDF]: "Invoice PDF",
};

export function legacySubscriptionDocumentTypePrefix(
  documentTypeId: number,
): string {
  return (
    LEGACY_SUBSCRIPTION_DOCUMENT_TYPE_PREFIXES[documentTypeId] ?? "document_"
  );
}
