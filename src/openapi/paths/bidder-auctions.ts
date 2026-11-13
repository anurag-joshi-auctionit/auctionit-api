import { z } from "zod";
import { closedDateRangeQuerySchema } from "../../lib/closed-auction-date-range.js";
import { ErrorBody, IdParam } from "../common.js";
import { documentRouter } from "../define.js";
import {
  BidderAuctionDetail,
  BidderAuctionList,
  BidderAuctionPendingTnc,
  BidderAuctionTncAccepted,
} from "../responses/bidder-auctions.js";

// Docs for src/routes/bidder-auctions.ts — see docs/api/README.md.
const r = documentRouter("/auctions/me");

// Recreated from `listQuerySchema` in src/routes/bidder-auctions.ts (defined inline there as
// `closedDateRangeQuerySchema.and(z.object({ bucket }))`). Flattened to one object here because
// OpenAPI query params can't be derived from an intersection; the from/to pairing refinement still applies.
const bidderAuctionsListQuerySchema = closedDateRangeQuerySchema.innerType().extend({
  bucket: z.enum(["today", "future", "closed"]).default("today"),
});

const notBidder = (extra = "") => ({
  description: `The session has no bidder account${extra}.`,
  schema: ErrorBody,
});
const badId = { description: "Invalid auction id.", schema: ErrorBody };

r.get("/", {
  summary: "My auctions by bucket",
  description:
    "Full (unpaginated) list for one bucket, ordered by client name so the portal can group by client.\n\n" +
    "- `today`: published, dated today (IST), schedule still open (live or upcoming); bidder mapped to a lot.\n" +
    "- `future`: published, dated after today; bidder mapped to a lot.\n" +
    "- `closed`: closed auctions where the bidder placed at least one bid, newest first per client. " +
    "`from`/`to` (YYYY-MM-DD, both or neither) filter by auction date and only apply to this bucket.",
  query: bidderAuctionsListQuerySchema,
  responses: { 200: BidderAuctionList, 403: notBidder() },
});

r.get("/pending-tnc", {
  summary: "Auctions awaiting my T&C acceptance",
  description:
    "Published auctions dated today or later that the bidder is mapped to, that have a T&C document, " +
    "and whose T&C the bidder has not accepted yet. Oldest first.",
  responses: { 200: BidderAuctionPendingTnc, 403: notBidder() },
});

r.get("/:id/catalogue", {
  summary: "Download auction catalogue",
  description:
    "Redirects to a signed URL for the active catalogue. Allowed when the bidder is mapped to the auction, or for " +
    "any bidder while the auction is published (catalogue notifications can precede mapping).",
  params: IdParam,
  responses: {
    302: { description: "Redirects to a signed download URL." },
    400: badId,
    403: notBidder(", or the bidder is not attached and the auction is not published"),
    404: { description: "No catalogue available.", schema: ErrorBody },
  },
});

r.get("/:id/tnc", {
  summary: "Download auction T&C",
  description: "Redirects to a signed URL for the active Terms & Conditions document.",
  params: IdParam,
  responses: {
    302: { description: "Redirects to a signed download URL." },
    400: badId,
    403: notBidder(", or the bidder is not attached to this auction"),
    404: { description: "No terms & conditions available.", schema: ErrorBody },
  },
});

r.post("/:id/accept-tnc", {
  summary: "Accept auction T&C",
  description:
    "Records the bidder's T&C acceptance with the request IP. Idempotent. When the auction has IP address " +
    "restriction on, an IP already used by another bidder in the same auction is refused.",
  params: IdParam,
  responses: {
    200: BidderAuctionTncAccepted,
    400: badId,
    403: notBidder(", the bidder is not attached to this auction, or the IP is already used by another bidder"),
  },
});

r.get("/:id", {
  summary: "My auction detail",
  description:
    "The auction's status picks the payload: published → `assigned` lot schedule (requires mapping); closed → " +
    "`participated` lots (requires at least one bid). Any other status is a 404. Start prices are not included.",
  params: IdParam,
  responses: {
    200: BidderAuctionDetail,
    400: badId,
    403: notBidder(", or (published) the bidder is not attached to this auction"),
    404: { description: "Auction not found, not published/closed, or (closed) the bidder never bid.", schema: ErrorBody },
  },
});
