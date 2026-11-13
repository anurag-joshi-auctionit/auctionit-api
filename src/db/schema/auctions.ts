import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  time,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { clients } from "./clients.js";
import { users } from "./users.js";

export const AUCTION_TYPES = ["forward", "reverse", "yankee"] as const;
export type AuctionType = (typeof AUCTION_TYPES)[number];

export const auctionTypeEnum = pgEnum("auction_type", AUCTION_TYPES);

export const AUCTION_STATUSES = [
  "draft",
  "archived",
  "published",
  "closed",
] as const;
export type AuctionStatus = (typeof AUCTION_STATUSES)[number];

/** Schedule buckets for published auctions — list filters, not DB statuses. */
export const AUCTION_SCHEDULE_BUCKETS = ["future", "upcoming", "live"] as const;
export type AuctionScheduleBucket = (typeof AUCTION_SCHEDULE_BUCKETS)[number];

export const auctionStatusEnum = pgEnum("auction_status", AUCTION_STATUSES);

export const auctions = pgTable(
  "auctions",
  {
    //identity
    id: integer("auction_id").primaryKey().notNull(),

    //refs
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id),

    //auction info
    auctionNumber: varchar("auction_number", { length: 50 }),
    auctionType: auctionTypeEnum("auction_type"),
    consolidatedEmdAmount: numeric("consolidated_emd_amount", {
      precision: 18,
      scale: 2,
    }),

    //schedule
    auctionDate: timestamp("auction_date", { withTimezone: true, mode: "string" }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }),

    //status
    status: auctionStatusEnum("status").notNull().default("draft"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    isActive: boolean("is_active").notNull().default(true),

    // No-bid lot extension settings
    noBidExtensionInterval: integer("no_bid_extension_interval"),
    noBidExtensionCountMax: integer("no_bid_extension_count_max").default(0),
    isNoBidExtension: boolean("is_no_bid_extension").default(true),
    isStartBidPricePlusIncrement: boolean(
      "is_start_bid_price_plus_increment",
    ).default(false),

    //EMD
    /** Days after close the winner has to lift; NULL = 30. */
    liftingWindowDays: integer("lifting_window_days"),
    /** Set when close-time EMD settlement has finished for this auction. */
    emdSettledAt: timestamp("emd_settled_at", { withTimezone: true, mode: "string" }),

    // Live per-auction stagger override: null = inherit client, true/false =
    // forced on/off (set via the Execution-phase Corrections "stagger" action).
    isStaggered: boolean("is_staggered"),

    //sealed-bid — window is IST wall-clock (sealed_bid_date + start/end time),
    //same model as auction_date + lot start/end time.
    isSealedBid: boolean("is_sealed_bid").notNull().default(false),
    sealedBidDate: timestamp("sealed_bid_date", {
      withTimezone: true,
      mode: "string",
    }),
    sealedBidStartTime: time("sealed_bid_start_time"),
    sealedBidEndTime: time("sealed_bid_end_time"),

    //access control
    ipAddressRestrictionEnabled: boolean(
      "ip_address_restriction_enabled",
    ).default(false),
    isRankBased: boolean("is_rank_based").notNull().default(false),

    //audit
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (table) => [
    check(
      "auctions_consolidated_emd_amount_non_negative",
      sql`${table.consolidatedEmdAmount} IS NULL OR ${table.consolidatedEmdAmount} >= 0`,
    ),
    check(
      "auctions_no_bid_extension_count_max_non_negative",
      sql`${table.noBidExtensionCountMax} IS NULL OR ${table.noBidExtensionCountMax} >= 0`,
    ),
    check(
      "auctions_sealed_bid_window_order",
      sql`${table.sealedBidStartTime} IS NULL OR ${table.sealedBidEndTime} IS NULL OR ${table.sealedBidStartTime} < ${table.sealedBidEndTime}`,
    ),
    // Live monitor list: published auctions by calendar day.
    index("auctions_status_auction_date_idx").on(table.status, table.auctionDate),
    // Prevent duplicate auction numbers per client among active, non-archived auctions.
    uniqueIndex("auctions_client_id_auction_number_active_uidx")
      .on(table.clientId, table.auctionNumber)
      .where(
        sql`${table.isActive} = true AND ${table.status} <> 'archived' AND ${table.auctionNumber} IS NOT NULL`,
      ),
  ],
);
