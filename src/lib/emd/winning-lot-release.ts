import { EmdErrorMessages, EmdValidationMessages } from "@auctionit/messages/emd";
import { round2 } from "./constants.js";
import { capByConsolidatedEmd } from "./emd-required.js";

/** One won lot of a Winning holding (auction, bidder, range) still above zero. */
export type HoldingLot = {
  lotId: number;
  auctionId: number;
  emdRangeId: number | null;
  /** Already released by an admin (`emd_winning_lot_releases`). */
  released: boolean;
  /** Rejected by the client; lot rejection has its own release path. */
  rejected: boolean;
  /** A forfeiture request on the holding is pending or approved. */
  forfeitureOpen: boolean;
};

export type HoldingWinning = {
  auctionId: number;
  emdRangeId: number | null;
  winning: number;
  /** Full EMD-range amount this holding would need on its own; equals `winning` for the no-range/legacy holding. */
  nominalAmount: number;
  /** Auction's consolidated EMD ceiling; null when unset. */
  consolidatedEmd: number | null;
  /** EMD range's display order, for allocating a shared pool across decided siblings; null for the no-range/legacy holding. */
  rangeOrder: number | null;
};

export type WinningRangeRelease = {
  auctionId: number;
  emdRangeId: number | null;
  amount: number;
  /** Every won lot of the holding, for `winning_lot_ids` on the credit. */
  lotIds: number[];
  /** Positions in the request that completed this holding. */
  requestIndexes: number[];
};

/** Outcome of one requested row, by request position. */
export type WinningLotRowResult = {
  lotId: number;
  /** Why the row was skipped; null when it is accepted. */
  error: string | null;
};

export type WinningLotReleasePlan = {
  results: WinningLotRowResult[];
  /** Holdings emptied by the accepted rows. */
  releases: WinningRangeRelease[];
  /**
   * Holdings whose own lots are all decided but still hold money, because the
   * bidder's other EMD ranges in the same auction still consume the
   * auction's consolidated EMD cap.
   */
  deferred: { auctionId: number; emdRangeId: number | null }[];
};

export const RELEASE_REMARKS_MAX = 500;

export function holdingKey(auctionId: number, emdRangeId: number | null): string {
  return `${auctionId}:${emdRangeId ?? 0}`;
}

/** A lot still waiting on an admin release. */
export function isPendingLot(lot: HoldingLot): boolean {
  return !lot.released && !lot.rejected;
}

/**
 * Checks each requested row on its own and works out which holdings the
 * accepted rows empty. Failed rows are skipped, so their lots stay pending: a
 * holding is only considered for release once no pending lot is left in it
 * (once the accepted rows are applied); otherwise the lots are recorded and
 * the money stays held.
 *
 * A holding with no pending lots left ("decided") only releases from a pool
 * shared with every other decided holding of the same bidder+auction: the
 * auction's consolidated EMD cap only has to keep covering whatever is still
 * *undecided* (a decided holding has no remaining claim on it), so
 * `releasablePool = totalBlocked - min(consolidatedEmd, sum of undecided
 * holdings' nominal amounts)`. That pool is handed out across the decided
 * holdings in ascending EMD range order (mirroring how close-settlement
 * fills them), so a range can stay (partly) held even once every lot in it
 * is decided, while an earlier-ordered sibling drains the pool first. Every
 * holding in `input.winning` is re-evaluated on every call (not just ones
 * touched by this request), so a holding deferred by an earlier call is
 * picked up automatically once enough of its siblings become decided or
 * free up headroom.
 */
export function planWinningLotRelease(input: {
  lots: HoldingLot[];
  winning: HoldingWinning[];
  requested: { lotId: number; remarks: string }[];
}): WinningLotReleasePlan {
  const lotById = new Map(input.lots.map((l) => [l.lotId, l]));
  const seen = new Set<number>();
  const accepted = new Map<number, number>();

  const results = input.requested.map(({ lotId, remarks }, i): WinningLotRowResult => {
    const lot = lotById.get(lotId);
    const remark = remarks.trim();
    let error: string | null = null;
    if (seen.has(lotId)) error = EmdErrorMessages.RELEASE_LOT_DUPLICATE;
    else if (!lot || lot.rejected) error = EmdErrorMessages.RELEASE_LOT_NOT_PENDING;
    else if (lot.released) error = EmdErrorMessages.RELEASE_LOT_ALREADY_RELEASED;
    else if (lot.forfeitureOpen) error = EmdErrorMessages.RELEASE_LOT_FORFEITURE_OPEN;
    else if (remark === "") error = EmdValidationMessages.REMARKS_REQUIRED;
    else if (remark.length > RELEASE_REMARKS_MAX) error = EmdValidationMessages.REMARKS_MAX;
    seen.add(lotId);
    if (!error) accepted.set(lotId, i);
    return { lotId, error };
  });

  const lotsByHolding = new Map<string, HoldingLot[]>();
  for (const lot of input.lots) {
    const key = holdingKey(lot.auctionId, lot.emdRangeId);
    const list = lotsByHolding.get(key) ?? [];
    list.push(lot);
    lotsByHolding.set(key, list);
  }

  const byAuction = new Map<number, HoldingWinning[]>();
  for (const holding of input.winning) {
    const list = byAuction.get(holding.auctionId) ?? [];
    list.push(holding);
    byAuction.set(holding.auctionId, list);
  }

  const requestIndexesOf = (holding: HoldingWinning) => {
    const lots = lotsByHolding.get(holdingKey(holding.auctionId, holding.emdRangeId)) ?? [];
    return lots
      .flatMap((l) => {
        const i = accepted.get(l.lotId);
        return i == null ? [] : [i];
      })
      .sort((a, b) => a - b);
  };
  const lotIdsOf = (holding: HoldingWinning) =>
    (lotsByHolding.get(holdingKey(holding.auctionId, holding.emdRangeId)) ?? [])
      .map((l) => l.lotId)
      .sort((a, b) => a - b);
  const isDecided = (holding: HoldingWinning) => {
    const lots = lotsByHolding.get(holdingKey(holding.auctionId, holding.emdRangeId)) ?? [];
    return !lots.some((l) => isPendingLot(l) && !accepted.has(l.lotId));
  };

  const releases: WinningRangeRelease[] = [];
  const deferred: WinningLotReleasePlan["deferred"] = [];
  for (const siblings of byAuction.values()) {
    const decided = siblings.filter(isDecided);
    if (decided.length === 0) continue;

    const undecided = siblings.filter((s) => !isDecided(s));
    const undecidedNominalSum = undecided.reduce((sum, s) => sum + s.nominalAmount, 0);
    const consolidatedEmd = siblings[0]!.consolidatedEmd;
    const requiredToStayBlocked = capByConsolidatedEmd(consolidatedEmd, undecidedNominalSum);
    const totalBlocked = siblings.reduce((sum, s) => sum + s.winning, 0);
    let remainingPool = round2(Math.max(0, totalBlocked - requiredToStayBlocked));

    const ordered = [...decided].sort(
      (a, b) =>
        (a.rangeOrder ?? Number.MAX_SAFE_INTEGER) - (b.rangeOrder ?? Number.MAX_SAFE_INTEGER) ||
        (a.emdRangeId ?? 0) - (b.emdRangeId ?? 0),
    );
    for (const holding of ordered) {
      const amount = round2(Math.min(remainingPool, holding.winning));
      remainingPool = round2(remainingPool - amount);
      if (amount > 0) {
        releases.push({
          auctionId: holding.auctionId,
          emdRangeId: holding.emdRangeId,
          amount,
          lotIds: lotIdsOf(holding),
          requestIndexes: requestIndexesOf(holding),
        });
      }
      if (amount < holding.winning) {
        deferred.push({ auctionId: holding.auctionId, emdRangeId: holding.emdRangeId });
      }
    }
  }
  return { results, releases, deferred };
}
