import type { LoadingScope } from "@auctionit/lib/loading-scope";
import type { FuzzyMatchResult } from "@auctionit/lib/fuzzy-match";
import type {
  ImportProgress,
  ImportResult,
  ImportSseError,
  ImportRowIssue,
} from "@auctionit/xlsx-import/types";

export type AuctionLotImportProgress = ImportProgress;
export type { ImportRowIssue };
/** Lot import result; `withdrawn` is used to decide published→draft revert. */
export type AuctionLotImportResult = ImportResult & { withdrawn: number };
export type AuctionLotImportSseError = ImportSseError;

export type AuctionLotImportNeedsReview = {
  stagingId: string;
  /** Valid rows placed into staging (awaiting item match / confirm). */
  parsed: number;
  failed: number;
  skipped: number;
  /** parsed + failed + skipped */
  total: number;
  issues: ImportRowIssue[];
  issuesTruncated?: boolean;
};

/** Per-row payload stored in staging session (masters already resolved). */
export type AuctionLotImportStagingRow = {
  rowNumber: number;
  lotNumber: string;
  materialLiftingDays: number | null;
  plantLocationId: number;
  materialLocationId: number | null;
  gstPercentage: 0 | 5 | 12 | 18 | 28;
  tcsPercentage: number;
  startBidPrice: number;
  bidLimit: number;
  bidIncrement: number;
  lotStartTime: string;
  lotEndTime: string;
  loadingScope: LoadingScope | null;
  displayOrder: number;
  remark: string;
  quantity: number;
  uomCode: string;
  uomId: number;
  /** Excel label (`Material@@Location`); null when blank. */
  benchmarkMaterial: string | null;
  benchmarkMaterialLocationId: number | null;
  materialName: string;
  materialDescription: string | null;
  /** Present when Excel already had a valid itemId. */
  itemId: number | null;
  existingLotId: number | null;
  match: FuzzyMatchResult | null;
};

export type AuctionLotImportStagingPayload = {
  rows: AuctionLotImportStagingRow[];
};

export type AuctionLotImportStagingRowView = {
  rowNumber: number;
  lotNumber: string;
  displayOrder: number;
  materialName: string;
  startBidPrice: number;
  bidIncrement: number;
  bidLimit: number;
  benchmarkMaterial: string | null;
  benchmarkMaterialLocationId: number | null;
  quantity: number;
  uom: string;
  lotStartTime: string;
  lotEndTime: string;
  fuzzyCandidate: 0 | 1 | 2;
  score: number;
  suggestedItemIds: number[];
  selectedItemId: number | null;
};

export type AuctionLotImportStagingSessionView = {
  stagingId: string;
  auctionId: number;
  expiresAt: string;
  rows: AuctionLotImportStagingRowView[];
  items: { id: number; name: string }[];
  benchmarks: { id: number; label: string }[];
};
