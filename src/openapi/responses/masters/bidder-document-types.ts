import { paginated } from "../../common.js";
import { z } from "../../zod.js";
import { masterDocumentType } from "./shared.js";

// Mirrors BidderDocumentTypeMasterDto / MasterListResult in services/masters/bidder-document-types.service.ts.

export const MasterBidderDocumentType = masterDocumentType("MasterBidderDocumentType");

export const MasterBidderDocumentTypeList = paginated(MasterBidderDocumentType).openapi("MasterBidderDocumentTypeList");

export const MasterBidderDocumentTypeOptions = z
  .array(MasterBidderDocumentType)
  .openapi({ description: "Active rows only, ordered by id." });
