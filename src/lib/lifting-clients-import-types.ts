import type { ImportProgress, ImportResult, ImportSseError, ImportRowIssue } from "@auctionit/xlsx-import/types";

export type LiftingClientsImportProgressPhase = ImportProgress["phase"];
export type LiftingClientsImportProgress = ImportProgress;
export type { ImportRowIssue };
export type LiftingClientsImportResult = ImportResult;
export type LiftingClientsImportSseError = ImportSseError;

export type LiftingClientsImportScope = {
  clientIds: number[];
  auctionIds: number[];
};
