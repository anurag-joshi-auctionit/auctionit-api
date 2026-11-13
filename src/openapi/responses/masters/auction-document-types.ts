import { paginated } from "../../common.js";
import { z } from "../../zod.js";
import { masterDocumentType } from "./shared.js";

// Mirrors AuctionDocumentTypeMasterDto / MasterListResult in services/masters/auction-document-types.service.ts.

export const MasterAuctionDocumentType = masterDocumentType("MasterAuctionDocumentType");

export const MasterAuctionDocumentTypeList = paginated(MasterAuctionDocumentType).openapi("MasterAuctionDocumentTypeList");

export const MasterAuctionDocumentTypeOptions = z
  .array(MasterAuctionDocumentType)
  .openapi({ description: "Active rows only, ordered by id." });
