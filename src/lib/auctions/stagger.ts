/**
 * Lot stagger — sequential chain cascade and side-effect gates.
 *
 * Rule: no-bid / last-bid extension intervals apply only to the lot that
 * triggered them. Cascades then rebuild subsequent lots as a chain:
 * `end[n] = end[n-1] + stagger interval` (never extension + stagger).
 *
 * Staggering is only ever a side effect of an actual extension (no-bid or
 * last-bid) — a lot merely approaching its own scheduled end, with no
 * extension involved, never triggers a cascade.
 */

export function shouldStagger(
  enabled: boolean | null,
  intervalSec: number | null,
): boolean {
  return enabled === true && (intervalSec ?? 0) > 0;
}

export type CascadeLotInput = {
  id: number;
  displayOrder: number | null;
  /** Effective end as epoch milliseconds. */
  effectiveEndMs: number;
};

export type CascadePlanItem = {
  lotId: number;
  oldEndsAtMs: number;
  newEndsAtMs: number;
  extendedBySec: number;
};

function sortLotsForCascade(lots: CascadeLotInput[]): CascadeLotInput[] {
  return [...lots].sort((a, b) => {
    const ao = a.displayOrder;
    const bo = b.displayOrder;
    if (ao != null && bo != null && ao !== bo) return ao - bo;
    if (ao != null && bo == null) return -1;
    if (ao == null && bo != null) return 1;
    return a.id - b.id;
  });
}

/**
 * Plan sequential stagger chain from an anchor: each later lot becomes
 * `prevEnd + intervalSec`, walking display_order. Callers that just applied
 * a no-bid / last-bid extension must pass the **post-extension** end as
 * `anchorEndMs` so the chain starts from the new end.
 *
 * Never moves a later lot earlier: `newEnd = max(currentEnd, prev + interval)`.
 * Skips lots that have already closed (`effectiveEnd <= nowMs`). Idempotent:
 * skips a write when the lot is already at/past the chained instant.
 */
export function planCascadeFromAnchor(input: {
  enabled: boolean;
  intervalSec: number;
  anchorLotId: number;
  /** Anchor's current (post-extension) effective end, epoch ms. */
  anchorEndMs: number;
  lots: CascadeLotInput[];
  /** Wall clock for skipping closed lots; defaults to Date.now(). */
  nowMs?: number;
}): CascadePlanItem[] {
  if (!shouldStagger(input.enabled, input.intervalSec)) return [];
  const intervalSec = input.intervalSec;
  const intervalMs = intervalSec * 1000;
  const nowMs = input.nowMs ?? Date.now();
  const sorted = sortLotsForCascade(input.lots);
  const anchorIdx = sorted.findIndex((l) => l.id === input.anchorLotId);
  if (anchorIdx < 0) return [];

  let prevEndMs = input.anchorEndMs;
  const out: CascadePlanItem[] = [];

  for (let i = anchorIdx + 1; i < sorted.length; i++) {
    const lot = sorted[i]!;
    // Closed lots stay closed, but still anchor the chain for later lots.
    // Match open-lot gates elsewhere: still open while effectiveEnd >= now.
    if (lot.effectiveEndMs < nowMs) {
      prevEndMs = lot.effectiveEndMs;
      continue;
    }

    const chainedMs = prevEndMs + intervalMs;
    const newEndsAtMs = Math.max(lot.effectiveEndMs, chainedMs);
    prevEndMs = newEndsAtMs;

    // Already at/past the chain target — no write needed.
    if (lot.effectiveEndMs >= chainedMs - 500) continue;

    const extendedBySec = Math.round((newEndsAtMs - lot.effectiveEndMs) / 1000);
    out.push({
      lotId: lot.id,
      oldEndsAtMs: lot.effectiveEndMs,
      newEndsAtMs,
      extendedBySec,
    });
  }
  return out;
}
