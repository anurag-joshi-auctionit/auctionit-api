import {
  EMD_TYPE_TXN_TYPE,
  type EmdType,
} from "../../db/schema/emd-transactions.js";

export { EMD_TYPE_TXN_TYPE };

/**
 * Debits that move money from Available into an auction's Blocked balance.
 * `blocked_winning` is no longer posted (a won range just stays blocked); it
 * remains here for ledger rows written before that change. `blocked_winning_correction`
 * is posted when a winner correction needs a fresh wallet block for a new winner
 * who held nothing for that EMD range.
 */
export const EMD_BLOCK_TYPES_IN = [
  "blocked_bidder_attached",
  "blocked_winning",
  "blocked_winning_correction",
] as const satisfies readonly EmdType[];

/**
 * Credits that return an auction's Blocked money to Available. Every way the
 * money leaves Blocked is one of these (or a forfeiture, which posts nothing):
 * at close for lots not won (including a reopened lot's old winner), on detach,
 * on lot rejection, at lifting, on a winner correction that reduces or removes
 * a bidder's held EMD range (`release_winning_correction`), ...
 */
export const EMD_BLOCK_RELEASE_TYPES = [
  "release_auction_closed",
  "release_bidder_detached",
  "release_lot_withdrawn",
  "release_bidder_unverified",
  "release_by_admin",
  "release_block_revised",
  "release_lot_rejected",
  "release_winning_by_admin",
  "release_winning_correction",
] as const satisfies readonly EmdType[];

export const EMD_DEFAULT_LIFTING_WINDOW_DAYS = 30;

/** Bidders written per transaction by the settlement worker. */
export const EMD_SETTLEMENT_CHUNK_SIZE = 500;

export const EMD_LIST_DEFAULT_PAGE_SIZE = 20;

/** `created_by` for entries the system posts without a user (settlement worker). */
export const EMD_SYSTEM_USER_ID = 1;

/** Settlement worker tick; matches the auto-close sweep cadence. */
export const EMD_SETTLEMENT_TICK_MS = 15_000;

export function sqlInList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(", ");
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function toAmount(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
