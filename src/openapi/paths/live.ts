import { z } from "zod";
import { AuthErrorBody, ErrorBody, IdParam } from "../common.js";
import { documentRouter } from "../define.js";
import {
  LiveAuctionList,
  LiveAuctionSnapshot,
  LiveBidAccepted,
  LiveLotAmountMap,
  LiveLotBidderList,
  LiveLotBidList,
  LiveLotDetails,
  LiveLotIdList,
  LiveProxyAccepted,
  LiveSealedBidAccepted,
  LiveSealedLotBidList,
  LiveSealedMyView,
  LiveSealedSummary,
  LiveSealedWindowAuctionList,
  LiveTransportConfig,
  LiveTransportMode,
  LiveWatchResult,
} from "../responses/live.js";

// Docs for src/routes/live.ts — see docs/api/README.md.
const r = documentRouter("/live");

// Recreated from src/routes/live.ts (schemas are defined inline there; the transport mode enum
// is `liveTransportModeSchema` in src/live/transport-config.ts, which does Redis I/O on import).
const transportModeBody = z.object({ mode: LiveTransportMode });
const bidSchema = z.object({
  amount: z.coerce.number().positive().describe("Bid amount (rupees). Numeric strings are accepted."),
});
const proxySchema = z.object({
  maxAmount: z.coerce.number().positive().describe("Auto-bid ceiling (forward) or floor (reverse)."),
});

const notBidder = { description: "The session has no bidder account.", schema: ErrorBody };
const badAuctionId = { description: "Invalid auction id.", schema: ErrorBody };
const badLotId = { description: "Invalid lot id.", schema: ErrorBody };
const badIds = { description: "Invalid auction or lot id.", schema: ErrorBody };
const clientDenied = {
  description:
    "Client user without `module.portal-client-auctions` (`code: permission_denied`), or not linked to this " +
    "auction/lot; bidder not registered for the auction; or a bidder hitting an admin-only drill-down.",
  schema: AuthErrorBody,
};

// ---- Transport -----------------------------------------------------------------

r.get("/transport", {
  summary: "Live transport policy",
  description:
    "Which push channel clients should use (Socket.IO, SSE fallback or polling) and the failover thresholds. " +
    "Clients read it on start-up and periodically.",
  responses: { 200: LiveTransportConfig },
});

r.put("/transport", {
  summary: "Set live transport mode",
  description:
    "Kill switch that forces every client onto one transport, or back to `auto`. Propagates to all API instances. " +
    "Setting `socket` closes every open SSE stream (`live:close` with `reason: transport_mode_changed`). " +
    "Staff admins only (bidder accounts are refused even with an admin role).",
  body: transportModeBody,
  responses: {
    200: LiveTransportConfig,
    403: { description: "Not a staff admin.", schema: ErrorBody },
  },
});

r.get("/stream", {
  summary: "Live updates over Server-Sent Events",
  description:
    "Server→client fallback for the Socket.IO channel; bids still go through the REST endpoints. EventSource " +
    "can't set headers, so pass `?app_id=` and the matching session cookie authenticates. Up to 25 auctions per " +
    "stream; each is joined in the same audience room its socket would get (admin / client / public bidder), " +
    "and auctions the user may not watch are reported with `live:error` instead of failing the stream.\n\n" +
    "The stream starts with `retry: <sseRetryMs>`, then:\n" +
    "- `live:meta` — `{ transport: \"sse\", serverTime, auctionIds }` (the auctions actually joined).\n" +
    "- `live:error` — `{ error: \"not_authorized\", auctionId }` for each denied auction.\n" +
    "- `live:snapshot` — `LiveAuctionSnapshot`: once per auction on join (personal projection for bidders), then " +
    "shared room snapshots after extensions and on periodic resync.\n" +
    "- `live:lot` — `LiveLotDelta` after every accepted bid / proxy (projected for the room).\n" +
    "- `live:standing` — `LiveStanding`, bidders only: private `{ auctionId, lotId, yourStatus, currentBid, seq, rev, " +
    "yourRank?, yourBid? }` when their standing may have changed.\n" +
    "- `live:ping` — `{ serverTime }` (epoch ms) heartbeat; use it to detect a silent stream.\n" +
    "- `live:close` — `{ reason }` just before the server ends the stream (e.g. `transport_mode_changed`).",
  query: z.object({
    auctionIds: z.string().describe("Comma-separated auction ids (also accepted as repeated params). Max 25 used."),
    app_id: z.string().optional().describe("App id whose `session_<appId>` cookie authenticates the stream."),
  }),
  responses: {
    200: {
      description: "`text/event-stream` of the events listed above.",
      schema: z.string(),
      contentType: "text/event-stream",
    },
    400: { description: "`auctionIds` is missing or has no valid id.", schema: ErrorBody },
    401: { description: "Not logged in.", schema: AuthErrorBody },
    403: { description: "The user may watch none of the requested auctions.", schema: ErrorBody },
    503: { description: "SSE transport disabled, or the server is at its SSE client cap.", schema: ErrorBody },
  },
});

// ---- Live auctions -------------------------------------------------------------

r.get("/auctions", {
  summary: "Auctions live right now",
  description:
    "Today's (IST) published auctions whose first lot has started and whose last lot hasn't ended, max 100. " +
    "Bidders see only auctions they are mapped to, with `tncRequired` and " +
    "`attachedLotIds`; client users see their companies' auctions; admins see all.",
  responses: { 200: LiveAuctionList, 403: clientDenied },
});

r.get("/auctions/:id", {
  summary: "Live auction snapshot",
  description:
    "Full state of every lot, projected for the caller: admins get everything; client users get winner identity; " +
    "bidders get only their mapped lots, never winner identity, no winning amount on rank-based auctions, and their " +
    "own `yourStatus` (and `yourRank` / `yourBid` on rank-based auctions). Subsequent changes arrive over Socket.IO " +
    "or GET /live/stream.",
  params: IdParam,
  responses: {
    200: LiveAuctionSnapshot,
    400: badAuctionId,
    403: clientDenied,
    404: { description: "Auction not found.", schema: ErrorBody },
  },
});

r.get("/lots/:lotId/bids", {
  summary: "Bid history of a lot",
  description: "Every live bid on the lot, newest first, with bidder, proxy flag and IP. Admins and linked client users.",
  responses: { 200: LiveLotBidList, 400: badLotId, 403: clientDenied },
});

r.get("/lots/:lotId/bidders", {
  summary: "Bidders on a lot",
  description:
    "Distinct bidders who bid on the lot with bid count, best amount and winner flag, best first (rank on " +
    "rank-based auctions). Admins and linked client users.",
  responses: { 200: LiveLotBidderList, 400: badLotId, 403: clientDenied },
});

r.get("/lots/:lotId/details", {
  summary: "Lot details",
  description:
    "Static \"other details\" for a lot: pricing, locations, taxes, schedule and line items. Client users must be " +
    "linked to the lot; bidders must be mapped to it (auction-wide or per lot), and while the sealed-bid window " +
    "hasn't closed yet get `startBidPrice` and `bidLimit` as `null`. " +
    "Staff see everything.",
  responses: {
    200: LiveLotDetails,
    400: badLotId,
    403: { description: "Client user not linked to the lot, or bidder not mapped to it.", schema: ErrorBody },
    404: { description: "Lot not found.", schema: ErrorBody },
  },
});

r.post("/auctions/:auctionId/lots/:lotId/bid", {
  summary: "Place a live bid",
  description:
    "Places a manual bid on a running lot. On success the lot delta is pushed to every room (`live:lot`), affected " +
    "bidders get `live:standing`, and an anti-sniping extension also pushes a fresh snapshot.\n\n" +
    "Rejections return **400** `{ error }` with the reason, including:\n" +
    "- lot not found / not in this auction; yankee auctions;\n" +
    "- bidding not started yet, or time is over;\n" +
    "- bidder not registered for the auction/lot, T&C not accepted, or IP already used by another bidder when IP " +
    "restriction is on;\n" +
    "- amount bounds: opening bid ≥ start price (or start price + increment when \"First Bid = SBP + Increment\"), " +
    "later bids ≥ winning + increment (≤ winning − decrement for reverse), multiples of the increment, at most " +
    "50 increments past the current price, and within the bid limit;\n" +
    "- rank-based auctions: bounds are relative to the bidder's own best bid, never the (withheld) winning price;\n" +
    "- a manual bid must beat the bidder's own active proxy (which it then retires).",
  body: bidSchema,
  responses: {
    200: LiveBidAccepted,
    400: { description: "Invalid ids or body, or the bid was rejected (`error` names the rule).", schema: ErrorBody },
    403: notBidder,
  },
});

r.post("/auctions/:auctionId/lots/:lotId/proxy", {
  summary: "Set an auto-bid (proxy)",
  description:
    "Sets or raises the bidder's proxy maximum (forward) / lowers its minimum (reverse) and settles it against " +
    "competing proxies immediately; pushes the same `live:lot` / `live:standing` / snapshot updates as a bid.\n\n" +
    "Rejections return **400** `{ error }`, including: lot not found / mismatch; auction type not supported for " +
    "proxy bidding; sealed-bid auctions (no proxies); not started / time over; registration, T&C and IP gates; lot " +
    "has no increment; amount ≤ 0; the max must at least meet the current winning price and the next-bid bound and " +
    "stay within the bid limit / 50-increment cap (on rank-based auctions, bounds use the bidder's own best bid); " +
    "an existing proxy can only be raised (forward) or lowered (reverse).",
  body: proxySchema,
  responses: {
    200: LiveProxyAccepted,
    400: { description: "Invalid ids or body, or the proxy was rejected.", schema: ErrorBody },
    403: notBidder,
  },
});

r.get("/auctions/:auctionId/my-proxies", {
  summary: "My active proxies in an auction",
  responses: { 200: LiveLotAmountMap, 400: badAuctionId, 403: notBidder },
});

r.get("/my-proxies", {
  summary: "My active proxies across auctions",
  responses: { 200: LiveLotAmountMap, 403: notBidder },
});

r.get("/my-participation", {
  summary: "Lots I have bid on",
  description: "Lot ids the bidder has bid on or holds an active proxy for.",
  responses: { 200: LiveLotIdList, 403: notBidder },
});

r.get("/watchlist", {
  summary: "My watch list",
  description: "Watched lot ids on still-published auctions.",
  responses: { 200: LiveLotIdList, 403: notBidder },
});

r.post("/lots/:lotId/watch", {
  summary: "Watch a lot",
  description: "Adds the lot to the bidder's watch list (idempotent).",
  responses: { 200: LiveWatchResult, 400: badLotId, 403: notBidder },
});

r.delete("/lots/:lotId/watch", {
  summary: "Unwatch a lot",
  responses: { 200: LiveWatchResult, 400: badLotId, 403: notBidder },
});

// ---- Sealed-bid window ---------------------------------------------------------

r.get("/sealed-auctions", {
  summary: "Auctions with an open sealed-bid window",
  description:
    "Published auctions whose sealed-bid window is open now, soonest closing first (max 100). Bidders see auctions " +
    "they are mapped to (with `tncRequired`); client users see their companies'; admins see all.",
  responses: { 200: LiveSealedWindowAuctionList, 403: clientDenied },
});

r.get("/auctions/:auctionId/sealed-bids/me", {
  summary: "My sealed-bid view",
  description:
    "Window times and the bidder's visible lots with only their own latest sealed-bid. The start price, bid limit, " +
    "leader, rank and other bidders' bids are deliberately withheld; the server enforces the bounds and names the " +
    "amount only when a bid is rejected.",
  responses: {
    200: LiveSealedMyView,
    400: badAuctionId,
    403: { description: "Not a bidder account, or not registered for the auction.", schema: ErrorBody },
    404: { description: "Auction not found or has no sealed-bid window.", schema: ErrorBody },
  },
});

r.post("/auctions/:auctionId/lots/:lotId/sealed-bid", {
  summary: "Place a sealed-bid",
  description:
    "Appends a sealed-bid; the bidder's latest bid is the one that counts and ties go to the earliest bid. No push " +
    "is sent — nothing about other bids is revealed.\n\n" +
    "Rejections return **400** `{ error }`, including: lot not found / mismatch; auction has no sealed-bid window; " +
    "unsupported auction type; window not open yet or closed; registration, T&C and IP gates; amount ≤ 0; a new bid " +
    "must beat the bidder's previous one (higher forward, lower reverse); and the amount must respect the start price " +
    "and bid limit — those rejections state the bound amount (\"Bid Amount should be greater than or equal to ₹…\") " +
    "because the bidder is never shown the start price or limit.",
  body: bidSchema,
  responses: {
    200: LiveSealedBidAccepted,
    400: { description: "Invalid ids or body, or the sealed-bid was rejected.", schema: ErrorBody },
    403: notBidder,
  },
});

r.get("/auctions/:auctionId/sealed-bids/summary", {
  summary: "Sealed-bid summary per lot",
  description:
    "Per lot: start price, bid / bidder counts and the current leader (best latest bid per bidder, earliest wins a " +
    "tie). Admins and linked client users.",
  responses: {
    200: LiveSealedSummary,
    400: badAuctionId,
    403: { description: "Bidder account, or client not linked / without permission.", schema: AuthErrorBody },
  },
});

r.get("/lots/:lotId/sealed-bids", {
  summary: "Sealed-bids on a lot",
  description: "Every sealed-bid on the lot, newest first, flagging each bidder's latest bid and the leader.",
  responses: { 200: LiveSealedLotBidList, 400: badLotId, 403: clientDenied },
});
