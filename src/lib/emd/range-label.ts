/** Label of an EMD range by lot display order: `Lot 3` or `Lots 3-4`. */
export function emdRangeLabel(from: number, to: number): string {
  return from === to ? `Lot ${from}` : `Lots ${from}-${to}`;
}
