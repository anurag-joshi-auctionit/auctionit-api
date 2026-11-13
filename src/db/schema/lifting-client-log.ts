import {
  bigserial,
  date,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { auctionLots } from "./auction-lots.js";
import { auctions } from "./auctions.js";
import { clients } from "./clients.js";
import { items } from "./items.js";
import { users } from "./users.js";

/**
 * Client-side lifting history log (replaces MSSQL `tbl_Data_AuctionLiftingLot`).
 * `auction_lots.latest_lifted_*` is derived from the newest row per lot.
 */
export const liftingClientLogs = pgTable(
  "lifting_client_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey().notNull(),
    liftingEntryDate: timestamp("lifting_entry_date", { withTimezone: true, mode: "string",
    }).notNull(),
    liftingDate: date("lifting_date"),
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
    qty: numeric("qty", { precision: 18, scale: 3 }).notNull(),
    /** Maps to `lifting_client_dispositions.id` (1=OPEN … 5=LOT_CANCELLED). */
    liftingStatus: integer("lifting_status").notNull(),
    odn: varchar("odn", { length: 20 }),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    createdOn: date("created_on").notNull(),
    rfdlId: integer("rfdl_id"),
    rfdlReasonDescription: varchar("rfdl_reason_description", {
      length: 5000,
    }),
  },
  (table) => [
    index("lifting_client_logs_lot_idx").on(table.clientId, table.lotId),
    index("lifting_client_logs_lot_id_idx").on(table.lotId),
  ],
);
