import { z } from "../zod.js";

// Mirrors services/live-auction.service.ts (LiveLot, LiveAuctionSnapshot, LiveLotDelta,
// LiveAuctionListItem, lotBids, lotBidders, lotDetails), services/live-bid.service.ts
// (BidResult, ProxyResult, myProxies…), services/sealed-bid.service.ts and
// live/transport-config.ts (LiveTransportConfig).

const LiveStateEnum = z.enum(["live", "upcoming", "ended"]);
const Standing = z.enum(["winning", "outbid", "none"]);
const istWallClock = (description: string) =>
  z.string().nullable().openapi({ description: `${description} IST wall-clock, no offset.`, example: "2026-10-21T11:30:00" });

// ---- Transport -------------------------------------------------------------

export const LiveTransportMode = z.enum(["auto", "socket", "sse", "poll"]).openapi("LiveTransportMode", {
  description:
    "`auto` = Socket.IO with fallback to SSE then polling; `socket` = Socket.IO only (open SSE streams are closed); " +
    "`sse` = skip Socket.IO; `poll` = re-fetch snapshots every `pollIntervalMs`.",
});

export const LiveTransportConfig = z
  .object({
    mode: LiveTransportMode,
    sseEnabled: z.boolean().openapi({ description: "False when SSE is disabled server-side; don't open /live/stream." }),
    failoverConnectMs: z.number().int().openapi({ description: "Socket.IO unreachable this long → open the SSE fallback." }),
    failoverSilenceMs: z
      .number()
      .int()
      .openapi({ description: "No event (heartbeats included) for this long → drop to polling." }),
    pollIntervalMs: z.number().int(),
    sseRetryMs: z.number().int().openapi({ description: "EventSource `retry:` sent at the start of /live/stream." }),
    updatedAt: z.string().nullable(),
    updatedByUserId: z.number().int().nullable(),
  })
  .openapi("LiveTransportConfig");

// ---- Live auctions -----------------------------------------------------------

export const LiveAuctionListItem = z
  .object({
    id: z.number().int(),
    auctionNumber: z.string().nullable(),
    clientId: z.number().int().nullable(),
    clientName: z.string().nullable(),
    auctionDate: z.string(),
    lotCount: z.number().int(),
    liveState: LiveStateEnum,
    tncRequired: z
      .boolean()
      .openapi({ description: "Bidder view only: T&C must be accepted before entering/bidding. Always false otherwise." }),
    attachedLotIds: z.array(z.number().int()).nullable().openapi({
      description: "Bidder view only: lot ids the bidder is mapped to. `null` = all lots (auction-wide map, admin, client).",
    }),
  })
  .openapi("LiveAuctionListItem");

export const LiveAuctionList = z.array(LiveAuctionListItem).openapi("LiveAuctionList");

export const LiveLot = z
  .object({
    id: z.number().int(),
    lotNumber: z.string().nullable(),
    displayOrder: z.number().int().nullable(),
    title: z.string().nullable().openapi({ description: "Material name of the first lot item." }),
    materialLocation: z.string().nullable(),
    quantity: z.number().nullable(),
    uom: z.string().nullable(),
    startBidPrice: z.number().nullable().openapi({
      description: "`null` for bidders while the sealed-bid window hasn't closed yet.",
    }),
    bidIncrement: z.number(),
    currentBid: z.number().nullable().openapi({
      description:
        "Winning amount, or the start price when there are no bids. `null` for bidders on rank-based auctions and during the sealed-bid phase.",
    }),
    winnerBidderId: z.number().int().nullable().openapi({ description: "Always `null` in the bidder projection." }),
    winnerBidderName: z.string().nullable().openapi({ description: "Always `null` in the bidder projection." }),
    startsAt: istWallClock("Lot start."),
    endsAt: istWallClock("Effective end including anti-sniping extensions."),
    startLeftSec: z.number().int().openapi({ description: "Seconds until the lot opens (≤ 0 once started)." }),
    timeLeftSec: z.number().int().openapi({ description: "Seconds left, clamped to ≥ 0." }),
    notStarted: z.boolean(),
    closed: z.boolean(),
    reopened: z.boolean().openapi({ description: "Admin reopened the lot: own end time, no stagger, no extensions." }),
    lastBidExtensionCount: z.number().int(),
    bidCount: z.number().int(),
    bidderCount: z.number().int(),
    bidLimit: z.number().nullable().openapi({
      description: "Unset, or withheld from bidders during the sealed-bid phase.",
    }),
    rev: z.number().int().openapi({
      description: "Monotonic per-lot revision. Ignore any payload whose `rev` is older than what you already hold.",
    }),
    sbpPlusIncrement: z
      .boolean()
      .openapi({ description: "When true the opening bid must clear start price + one increment." }),
    yourStatus: Standing.optional().openapi({ description: "Bidder's personal snapshot only." }),
    yourRank: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ description: "Bidder's personal snapshot, rank-based auctions only (1 = leading; null = no bid yet)." }),
    yourBid: z
      .number()
      .nullable()
      .optional()
      .openapi({ description: "Bidder's personal snapshot, rank-based auctions only: own best bid." }),
  })
  .openapi("LiveLot");

export const LiveAuctionSnapshot = z
  .object({
    auction: z.object({
      id: z.number().int(),
      auctionNumber: z.string().nullable(),
      auctionType: z.string().nullable(),
      clientName: z.string().nullable(),
      status: z.string(),
      liveState: LiveStateEnum,
      isRankBased: z.boolean(),
    }),
    lots: z.array(LiveLot),
    serverTime: z.string().openapi({ description: "Database `now()` at read time (UTC ISO); anchor countdowns to it." }),
    seq: z.number().int().openapi({ description: "Per-auction sequence shared by snapshots and deltas." }),
  })
  .openapi("LiveAuctionSnapshot", {
    description:
      "Projected per audience: **admin** — everything; **client** — winner identity, no `yourStatus`; " +
      "**bidder** — only the bidder's mapped lots, winner id/name stripped, `currentBid` masked on rank-based " +
      "auctions, `startBidPrice` / `bidLimit` / `currentBid` masked during the sealed-bid phase, plus personal " +
      "`yourStatus` / `yourRank` / `yourBid`.",
  });

export const LiveLotDelta = z
  .object({
    auctionId: z.number().int(),
    lotId: z.number().int(),
    currentBid: z.number().nullable(),
    winnerBidderId: z.number().int().nullable(),
    winnerBidderName: z.string().nullable(),
    bidCount: z.number().int(),
    bidderCount: z.number().int(),
    seq: z.number().int(),
    isRankBased: z.boolean().optional(),
    sealedPhase: z
      .boolean()
      .optional()
      .openapi({ description: "Sealed-bid phase: `currentBid` is masked for bidders." }),
    rev: z.number().int(),
    timeLeftSec: z.number().int().optional(),
    startLeftSec: z.number().int().optional(),
    endsAt: z.string().nullable().optional(),
    lastBidExtensionCount: z.number().int().optional(),
    closed: z.boolean().optional(),
    notStarted: z.boolean().optional(),
    serverTime: z.string().optional(),
  })
  .openapi("LiveLotDelta", { description: "Per-lot patch pushed as `live:lot`; projected per audience like snapshots." });

export const LiveStanding = z
  .object({
    auctionId: z.number().int(),
    lotId: z.number().int(),
    yourStatus: Standing,
    currentBid: z
      .number()
      .nullable()
      .openapi({ description: "`null` on rank-based auctions and during the sealed-bid phase." }),
    seq: z.number().int().optional(),
    rev: z.number().int().optional(),
    yourRank: z.number().int().nullable().optional().openapi({ description: "Rank-based auctions only." }),
    yourBid: z.number().nullable().optional().openapi({ description: "Rank-based auctions only." }),
  })
  .openapi("LiveStanding", { description: "Private per-bidder standing ping (`live:standing`)." });

// ---- Lot drill-downs ---------------------------------------------------------

export const LiveLotBid = z
  .object({
    id: z.number().int(),
    bidderId: z.number().int(),
    bidderName: z.string().nullable(),
    amount: z.number(),
    isProxy: z.boolean(),
    proxyAmount: z.number().nullable(),
    ip: z.string().nullable(),
    placedAt: z.string().nullable().openapi({ description: "IST wall-clock with microseconds." }),
  })
  .openapi("LiveLotBid");

export const LiveLotBidList = z.array(LiveLotBid).openapi("LiveLotBidList");

export const LiveLotBidder = z
  .object({
    bidderId: z.number().int(),
    bidderName: z.string().nullable(),
    bids: z.number().int(),
    bestAmount: z.number().nullable(),
    lastBidAt: z.string().nullable(),
    isWinner: z.boolean(),
    rank: z.number().int().nullable().openapi({ description: "Rank-based auctions only; `null` otherwise." }),
  })
  .openapi("LiveLotBidder");

export const LiveLotBidderList = z.array(LiveLotBidder).openapi("LiveLotBidderList");

export const LiveLotDetails = z
  .object({
    id: z.number().int(),
    lotNumber: z.string().nullable(),
    quantity: z.number().nullable(),
    uom: z.string().nullable(),
    startBidPrice: z
      .number()
      .nullable()
      .openapi({ description: "`null` for bidders during the sealed-bid phase." }),
    bidIncrement: z.number().nullable(),
    bidLimit: z
      .number()
      .nullable()
      .openapi({ description: "Unset, or `null` for bidders during the sealed-bid phase." }),
    plantLocation: z.string().nullable(),
    materialLocation: z.string().nullable(),
    materialLiftingDays: z.number().int().nullable(),
    loadingScope: z.string().nullable(),
    gstPercentage: z.number().nullable(),
    tcsPercentage: z.number().nullable(),
    startsAt: istWallClock("Lot start."),
    endsAt: istWallClock("Effective end."),
    lastBidExtensionCount: z.number().int(),
    items: z.array(
      z.object({
        id: z.number().int(),
        itemName: z.string().nullable(),
        materialName: z.string().nullable(),
        materialDescription: z.string().nullable(),
        quantity: z.number().nullable(),
        uom: z.string().nullable(),
      }),
    ),
  })
  .openapi("LiveLotDetails");

// ---- Bidding -----------------------------------------------------------------

const bidOutcome = {
  finalAmount: z
    .number()
    .nullable()
    .openapi({ description: "Winning amount after proxy settlement; `null` on rank-based auctions." }),
  yourStatus: z.enum(["winning", "outbid"]),
  rev: z.number().int(),
  extended: z.boolean().openapi({ description: "True when the bid triggered an anti-sniping extension." }),
  yourRank: z.number().int().nullable().openapi({ description: "Rank-based auctions only." }),
  yourBid: z.number().nullable().openapi({ description: "Rank-based auctions only: own best bid." }),
};

export const LiveBidAccepted = z
  .object({ ok: z.literal(true), amount: z.number(), ...bidOutcome })
  .openapi("LiveBidAccepted");

export const LiveProxyAccepted = z
  .object({ ok: z.literal(true), maxAmount: z.number(), ...bidOutcome })
  .openapi("LiveProxyAccepted");

export const LiveLotAmountMap = z.record(z.number()).openapi("LiveLotAmountMap", {
  description: "Lot id → active proxy max amount.",
  example: { "101": 125000, "102": 98000 },
});

export const LiveLotIdList = z.array(z.number().int()).openapi("LiveLotIdList");

export const LiveWatchResult = z.object({ ok: z.literal(true), watched: z.boolean() }).openapi("LiveWatchResult");

// ---- Sealed-bids ---------------------------------------------------------------

export const LiveSealedWindowAuction = z
  .object({
    id: z.number().int(),
    auctionNumber: z.string().nullable(),
    clientId: z.number().int().nullable(),
    clientName: z.string().nullable(),
    auctionType: z.string().nullable(),
    windowStartsAt: z.string().openapi({ description: "UTC ISO." }),
    windowEndsAt: z.string().openapi({ description: "UTC ISO." }),
    secondsLeft: z.number().int(),
    lotCount: z.number().int(),
    tncRequired: z.boolean().openapi({ description: "Bidder view only." }),
  })
  .openapi("LiveSealedWindowAuction");

export const LiveSealedWindowAuctionList = z.array(LiveSealedWindowAuction).openapi("LiveSealedWindowAuctionList");

export const LiveSealedMyView = z
  .object({
    auctionId: z.number().int(),
    auctionNumber: z.string().nullable(),
    clientName: z.string().nullable(),
    auctionType: z.string().nullable(),
    status: z.string(),
    windowStartsAt: z.string().nullable().openapi({ description: "UTC ISO." }),
    windowEndsAt: z.string().nullable().openapi({ description: "UTC ISO." }),
    serverTime: z.string(),
    tncRequired: z.boolean(),
    lots: z.array(
      z.object({
        lotId: z.number().int(),
        lotNumber: z.string().nullable(),
        title: z.string().nullable(),
        quantity: z.number().nullable(),
        uom: z.string().nullable(),
        materialLocation: z.string().nullable(),
        yourBid: z.number().nullable().openapi({ description: "The bidder's own latest sealed-bid." }),
        yourBidAt: z.string().nullable(),
        yourBidCount: z.number().int(),
      }),
    ),
  })
  .openapi("LiveSealedMyView", {
    description:
      "The bidder's own sealed-bid page. Deliberately carries no start price, bid limit, leader, rank or other " +
      "bidders' bids — only the bidder's own latest bid per visible lot.",
  });

export const LiveSealedBidAccepted = z
  .object({
    ok: z.literal(true),
    yourBid: z.number(),
    placedAt: z.string(),
  })
  .openapi("LiveSealedBidAccepted");

export const LiveSealedSummaryRow = z
  .object({
    lotId: z.number().int(),
    lotNumber: z.string().nullable(),
    startBidPrice: z.number().nullable(),
    quantity: z.number().nullable(),
    uom: z.string().nullable(),
    windowStartsAt: z.string().nullable(),
    windowEndsAt: z.string().nullable(),
    bidCount: z.number().int(),
    bidderCount: z.number().int(),
    leaderBidderId: z.number().int().nullable(),
    leaderBidderName: z.string().nullable(),
    leaderAmount: z.number().nullable(),
    leaderAt: z.string().nullable(),
  })
  .openapi("LiveSealedSummaryRow");

export const LiveSealedSummary = z.array(LiveSealedSummaryRow).openapi("LiveSealedSummary");

export const LiveSealedLotBid = z
  .object({
    id: z.number().int(),
    bidderId: z.number().int(),
    bidderName: z.string().nullable(),
    amount: z.number(),
    ip: z.string().nullable(),
    placedAt: z.string(),
    isLatest: z.boolean().openapi({ description: "The bidder's latest (counted) bid." }),
    isLeader: z.boolean().openapi({ description: "Current leader among latest bids (earliest wins a tie)." }),
  })
  .openapi("LiveSealedLotBid");

export const LiveSealedLotBidList = z.array(LiveSealedLotBid).openapi("LiveSealedLotBidList");
