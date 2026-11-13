import { paginated } from "../../common.js";
import { z } from "../../zod.js";
import { masterDocumentType } from "./shared.js";

// Mirrors ClientDocumentTypeMasterDto / MasterListResult in services/masters/client-document-types.service.ts.

export const MasterClientDocumentType = masterDocumentType("MasterClientDocumentType");

export const MasterClientDocumentTypeList = paginated(MasterClientDocumentType).openapi("MasterClientDocumentTypeList");

export const MasterClientDocumentTypeOptions = z
  .array(MasterClientDocumentType)
  .openapi({ description: "Active rows only, ordered by id." });
