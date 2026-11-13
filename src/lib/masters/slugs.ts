export const MASTERS_SLUGS = [
  "lifting-clients-disposition",
  "lifting-bidder-disposition",
  "bidder-document-types",
  "client-document-types",
  "auction-document-types",
  "uoms",
  "subscription-types",
  "payment-types",
  "emd-forfeiture-dispositions",
] as const;

export type MastersSlug = (typeof MASTERS_SLUGS)[number];

export function isMastersSlug(value: string): value is MastersSlug {
  return (MASTERS_SLUGS as readonly string[]).includes(value);
}
