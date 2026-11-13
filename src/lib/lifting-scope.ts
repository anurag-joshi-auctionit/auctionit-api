/** Internal / inactive clients excluded from lifting CRM. */
export const LIFTING_EXCLUDED_CLIENT_IDS = [2, 3] as const;

/** Auctions older than this are excluded from lifting client filters and list scope. */
export const LIFTING_CLIENT_AUCTION_LOOKBACK_DAYS = 1500;
