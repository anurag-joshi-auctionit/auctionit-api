import { paginated } from "../../common.js";
import { z } from "../../zod.js";
import { MasterDisposition } from "./shared.js";

// Mirrors BidderDispositionDto in services/masters/lifting-bidder-disposition.service.ts.

export const MasterLiftingBidderDisposition = MasterDisposition.extend({
  requiresLiftedQty: z.boolean().openapi({ description: "Lifting entry with this disposition must record a lifted quantity." }),
  requiresNextFollowup: z.boolean().openapi({ description: "Lifting entry with this disposition must set a next follow-up date." }),
}).openapi("MasterLiftingBidderDisposition");

export const MasterLiftingBidderDispositionList = paginated(MasterLiftingBidderDisposition).openapi(
  "MasterLiftingBidderDispositionList",
);

export const MasterLiftingBidderDispositionOptions = z
  .array(MasterLiftingBidderDisposition)
  .openapi({ description: "Active rows only." });
