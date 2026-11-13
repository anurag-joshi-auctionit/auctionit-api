import { paginated } from "../../common.js";
import { z } from "../../zod.js";

// Mirrors UomMasterDto / MasterListResult in services/masters/uoms.service.ts.

export const MasterUom = z
  .object({ id: z.number().int(), code: z.string(), isActive: z.boolean() })
  .openapi("MasterUom");

export const MasterUomList = paginated(MasterUom).openapi("MasterUomList");

export const MasterUomOptions = z.array(MasterUom).openapi({ description: "Active rows only." });
