/**
 * Links legacy passbook rows (no auction) to the records they belong to, for
 * `seed-emd.ts`. Legacy has no foreign keys for these, so matching is by
 * bidder, amount, time and remark. Each passbook row is claimed at most once.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type LegacyRow = {
  trnId: number;
  bidderId: number;
  amount: number;
  /** Epoch ms of CreatedOn. */
  at: number;
  remark: string;
  payEmdId: number | null;
  processStatus: number | null;
};

export type LegacyRefund = {
  id: number;
  bidderId: number;
  amount: number;
  /** Epoch ms of the request. */
  at: number;
  paid: boolean;
  cancelled: boolean;
  utr: string | null;
};

export type LegacyTransferPair = {
  debitTrnId: number;
  creditTrnId: number;
  fromBidderId: number;
  toBidderId: number;
  amount: number;
  at: number;
  remark: string;
};

function bucketKey(bidderId: number, amount: number): string {
  return `${bidderId}:${amount.toFixed(2)}`;
}

function bucket(rows: LegacyRow[]): Map<string, LegacyRow[]> {
  const out = new Map<string, LegacyRow[]>();
  for (const r of rows) {
    const k = bucketKey(r.bidderId, r.amount);
    const list = out.get(k) ?? [];
    list.push(r);
    out.set(k, list);
  }
  return out;
}

function nearest(rows: LegacyRow[], at: number): LegacyRow | undefined {
  let best: LegacyRow | undefined;
  for (const r of rows) {
    if (!best || Math.abs(r.at - at) < Math.abs(best.at - at)) best = r;
  }
  return best;
}

/**
 * Refund request → its passbook debit (trnId → refund id). Legacy debits the
 * balance when the request is raised and the payout remark often carries the
 * UTR. Tried in order: PayEMDId link, UTR in remark (paid only), same bidder
 * and amount from 1 day before to 2 days after the request (nearest wins).
 */
export function matchRefundDebits(
  refunds: LegacyRefund[],
  debits: LegacyRow[],
): Map<number, number> {
  const byKey = bucket(debits);
  const claimed = new Set<number>();
  const out = new Map<number, number>();
  const sorted = [...refunds].sort((a, b) => a.at - b.at || a.id - b.id);
  for (const refund of sorted) {
    const candidates = (byKey.get(bucketKey(refund.bidderId, refund.amount)) ?? []).filter(
      (d) => !claimed.has(d.trnId),
    );
    let hit = candidates.find((d) => d.processStatus === 1 && d.payEmdId === refund.id);
    const utr = refund.utr?.trim().slice(0, 12).toUpperCase();
    if (!hit && refund.paid && utr && utr.length >= 6) {
      hit = candidates.find((d) => d.remark.toUpperCase().includes(utr));
    }
    if (!hit) {
      hit = nearest(
        candidates.filter((d) => d.at >= refund.at - DAY_MS && d.at <= refund.at + 2 * DAY_MS),
        refund.at,
      );
    }
    if (!hit) continue;
    claimed.add(hit.trnId);
    out.set(hit.trnId, refund.id);
  }
  return out;
}

/**
 * Cancelled refund → the credit that gave the money back (trnId → refund id):
 * same bidder and amount, on or after the request, nearest first.
 */
export function matchCancelCredits(
  refunds: LegacyRefund[],
  credits: LegacyRow[],
): Map<number, number> {
  const byKey = bucket(credits);
  const claimed = new Set<number>();
  const out = new Map<number, number>();
  const sorted = refunds.filter((r) => r.cancelled).sort((a, b) => a.at - b.at || a.id - b.id);
  for (const refund of sorted) {
    const candidates = (byKey.get(bucketKey(refund.bidderId, refund.amount)) ?? []).filter(
      (c) => !claimed.has(c.trnId) && c.at >= refund.at - DAY_MS,
    );
    const hit = nearest(candidates, refund.at);
    if (!hit) continue;
    claimed.add(hit.trnId);
    out.set(hit.trnId, refund.id);
  }
  return out;
}

const TRANSFER_RE = /^EMD Transfer (To|From) Buyer .*\[(\d+)\]\s*$/i;

/**
 * A rarer, older remark shape with no "Buyer" word and no brackets, e.g.
 * "EMD Transfer From4583" / "EMD Transfer to2671" — seen on historical rows
 * pre-dating the "...Buyer <name>[id]" convention above.
 */
const TRANSFER_RE_SHORT = /^EMD Transfer (To|From)(\d+)\s*$/i;

/**
 * Loosely matches either real transfer shape above — not used for pairing,
 * only so `seed-emd.ts` can report any transfer-shaped row that fails BOTH
 * strict patterns. Deliberately excludes "EMD transfer(red) to <company>"
 * remarks, a different legacy concept (EMD paid out to an external
 * client/seller, not another bidder) that has no counterpart to pair against.
 */
export const TRANSFER_LOOSE_RE = /^EMD Transfer (To|From)(\s*Buyer\b.*|\d+\s*)$/i;

function parseTransferRemark(remark: string): { direction: "to" | "from"; counterpartyId: number } | null {
  const m = TRANSFER_RE.exec(remark) ?? TRANSFER_RE_SHORT.exec(remark);
  if (!m) return null;
  return { direction: m[1]!.toLowerCase() as "to" | "from", counterpartyId: Number(m[2]) };
}

/**
 * Pairs the two passbook rows the legacy `EMDTransfer` proc writes:
 * "EMD Transfer To Buyer <name>[to]" (debit on the source) and
 * "EMD Transfer From Buyer <name>[from]" (credit on the target), same amount
 * and timestamp.
 */
export function pairTransfers(debits: LegacyRow[], credits: LegacyRow[]): LegacyTransferPair[] {
  const creditsByKey = new Map<string, LegacyRow[]>();
  for (const c of credits) {
    const m = parseTransferRemark(c.remark.trim());
    if (!m || m.direction !== "from") continue;
    const k = `${m.counterpartyId}>${c.bidderId}:${c.amount.toFixed(2)}`;
    const list = creditsByKey.get(k) ?? [];
    list.push(c);
    creditsByKey.set(k, list);
  }
  const claimed = new Set<number>();
  const out: LegacyTransferPair[] = [];
  for (const d of debits) {
    const m = parseTransferRemark(d.remark.trim());
    if (!m || m.direction !== "to") continue;
    const toBidderId = m.counterpartyId;
    const candidates = (creditsByKey.get(`${d.bidderId}>${toBidderId}:${d.amount.toFixed(2)}`) ?? []).filter(
      (c) => !claimed.has(c.trnId) && Math.abs(c.at - d.at) <= DAY_MS,
    );
    const c = nearest(candidates, d.at);
    if (!c) continue;
    claimed.add(c.trnId);
    out.push({
      debitTrnId: d.trnId,
      creditTrnId: c.trnId,
      fromBidderId: d.bidderId,
      toBidderId,
      amount: d.amount,
      at: d.at,
      remark: d.remark.trim(),
    });
  }
  return out;
}
