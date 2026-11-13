/** Virtual account number bidders quote when depositing EMD (bank matches on it). */
export const BIDDER_VAN_PREFIX = "ICOM";

export function buildBidderVan(bidderId: number): string {
  return `${BIDDER_VAN_PREFIX}${bidderId}`;
}
