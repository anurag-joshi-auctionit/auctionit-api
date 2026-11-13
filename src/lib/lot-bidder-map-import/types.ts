export type LotBidderMapImportRawRow = {
  /** 1-based worksheet row number (header is row 1). */
  rowNumber: number;
  bidderId: number | null;
  bidderName: string;
  lotDisplayOrders: number[];
  lotDisplayOrdersRaw: string;
  emdDisplayOrders: number[];
  emdDisplayOrdersRaw: string;
  isEmdWithClientRaw: string;
};

export type ParseLotBidderMapImportSheetResult = {
  rows: LotBidderMapImportRawRow[];
  headerError: string | null;
};
