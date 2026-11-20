import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  time,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { auctions } from "./auctions.js";
import { benchmarkMaterialLocations } from "./benchmark-material-locations.js";
import { bidders } from "./bidders.js";
import { clients } from "./clients.js";
import { items } from "./items.js";
import { materialLocations } from "./material-locations.js";
import { plantLocations } from "./plant-locations.js";
import { uoms } from "./uoms.js";
import { users } from "./users.js";

export const auctionLots = pgTable(
  "auction_lots",
  {
    id: integer("id").primaryKey().notNull(),
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id),
    auctionId: integer("auction_id")
      .notNull()
      .references(() => auctions.id),
    lotNumber: varchar("lot_number", { length: 200 }),
    quantity: numeric("quantity", { precision: 18, scale: 3 }),
    startBidPrice: numeric("start_bid_price", { precision: 18, scale: 2 }),
    uomId: smallint("uom_id").references(() => uoms.id),
    bidIncrement: numeric("bid_increment", { precision: 18, scale: 2 }),
    bidQuantityIncrement: numeric("bid_quantity_increment", {
      precision: 18,
      scale: 2,
    }),
    /** Ceiling for forward auctions; floor for reverse (direction-neutral name). */
    bidLimit: numeric("bid_limit", { precision: 18, scale: 2 }),
    displayOrder: numeric("display_order", { precision: 10, scale: 3 }),
    startTime: time("start_time"),
    endTime: time("end_time"),
    plantLocationId: integer("plant_location_id").references(
      () => plantLocations.id,
    ),
    materialLocationId: integer("material_location_id").references(
      () => materialLocations.id,
    ),
    materialLiftingDays: smallint("material_lifting_days"),
    loadingScope: varchar("loading_scope", { length: 20 }),
    gstPercentage: numeric("gst_percentage", { precision: 18, scale: 3 }),
    tcsPercentage: numeric("tcs_percentage", { precision: 18, scale: 3 }),
    status: smallint("status"),
    isApproved: boolean("is_approved"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
    reviewedBy: integer("reviewed_by").references(() => users.id),
    // Denormalized from lifting_client_logs (latest row). Status 1 = OPEN.
    latestLiftedStatus: integer("latest_lifted_status").notNull().default(1),
    latestLiftedDate: date("latest_lifted_date"),
    latestLiftedQty: numeric("latest_lifted_qty", { precision: 18, scale: 3 })
      .notNull()
      .default("0"),
    winnerUserId: integer("winner_user_id"),
    winnerBidderId: integer("winner_bidder_id").references(() => bidders.id),
    winningAmount: numeric("winning_amount", { precision: 18, scale: 2 }),
    // Live anti-sniping: when a bid extends a lot, the effective end time is
    // stored here (overriding the derived auction_date + end_time). last_bid_extension_count
    // caps against the client's last_bid_extension_count_max.
    extendedEndTime: timestamp("extended_end_time", { withTimezone: true, mode: "string" }),
    lastBidExtensionCount: integer("last_bid_extension_count").notNull().default(0),
    // No-bid lot extension — per-lot runtime state
    noBidExtensionCount: integer("no_bid_extension_count").notNull().default(0),
    isNoBidExtension: boolean("is_no_bid_extension").notNull().default(true),
    // When / by whom no-bid extension was last stopped (is_no_bid_extension = false).
    noBidExtensionStoppedAt: timestamp("no_bid_extension_stopped_at", { withTimezone: true, mode: "string",
    }),
    noBidExtensionStoppedBy: integer("no_bid_extension_stopped_by").references(
      () => users.id,
    ),
    // Admin reopened this closed lot (Execution or Settlement corrections). A
    // reopened lot runs on its own end time: it is outside the lot-stagger chain
    // (never cascades, never cascaded) and gets no no-bid / last-bid extensions.
    isReopened: boolean("is_reopened").notNull().default(false),
    reopenedAt: timestamp("reopened_at", { withTimezone: true, mode: "string" }),
    reopenedBy: integer("reopened_by").references(() => users.id),
    // Monotonic revision of the lot's live state, bumped by every write the live
    // engine broadcasts (bid, proxy settlement, extension, bid removal). Bumped
    // while the lot row is locked, so it orders by commit — clients use it to
    // drop a snapshot or delta that was read before state they already applied.
    liveRev: integer("live_rev").notNull().default(0),
    // Denormalized bid stats (seeded from MSSQL transaction tables)
    bidCount: integer("bid_count").notNull().default(0),
    bidderCount: integer("bidder_count").notNull().default(0),
    bidderIds: integer("bidder_ids").array().notNull().default([]),
    remark: varchar("remark", { length: 200 }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (t) => [
    // Live snapshot / listLive / no-bid extension — every hot path filters by
    // auction_id (+ is_active). Without this index getSnapshot seq-scans ~188k rows.
    index("auction_lots_auction_id_is_active_idx").on(t.auctionId, t.isActive),
  ],
);

export const auctionLotItems = pgTable("auction_lot_items", {
  id: integer("id").primaryKey().notNull(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clients.id),
  auctionId: integer("auction_id")
    .notNull()
    .references(() => auctions.id),
  lotId: integer("lot_id")
    .notNull()
    .references(() => auctionLots.id),
  itemId: integer("item_id").references(() => items.id),
  quantity: numeric("quantity", { precision: 18, scale: 3 }).notNull(),
  benchmarkMaterialLocationId: integer(
    "benchmark_material_location_id",
  ).references(() => benchmarkMaterialLocations.id),
  materialName: varchar("material_name", { length: 500 }),
  materialDescription: varchar("material_description", { length: 1000 }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  createdBy: integer("created_by")
    .notNull()
    .references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  updatedBy: integer("updated_by").references(() => users.id),
});
