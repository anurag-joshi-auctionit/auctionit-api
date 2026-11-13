import {
  integer,
  numeric,
  pgTable,
  timestamp,
} from "drizzle-orm/pg-core";
import { auctions } from "./auctions.js";
import { users } from "./users.js";

export const auctionLotEmdRanges = pgTable("auction_lot_emd_ranges", {
  id: integer("id").primaryKey().notNull(),
  auctionId: integer("auction_id")
    .notNull()
    .references(() => auctions.id),
  lotDisplayOrderFrom: numeric("lot_display_order_from", {
    precision: 18,
    scale: 3,
  }).notNull(),
  lotDisplayOrderTo: numeric("lot_display_order_to", {
    precision: 18,
    scale: 3,
  }).notNull(),
  emdAmount: numeric("emd_amount", { precision: 18, scale: 2 }).notNull(),
  displayOrder: integer("display_order"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  createdBy: integer("created_by")
    .notNull()
    .references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  updatedBy: integer("updated_by").references(() => users.id),
});
