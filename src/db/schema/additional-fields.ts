import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import {
  ADDITIONAL_FIELD_DATA_TYPES,
  ADDITIONAL_FIELD_SCOPES,
} from "@auctionit/messages/clients";
import { auctionLots } from "./auction-lots.js";
import { auctions } from "./auctions.js";
import { clients } from "./clients.js";
import { users } from "./users.js";

export const additionalFieldScopeEnum = pgEnum(
  "additional_field_scope",
  ADDITIONAL_FIELD_SCOPES,
);

export const additionalFieldDataTypeEnum = pgEnum(
  "additional_field_data_type",
  ADDITIONAL_FIELD_DATA_TYPES,
);

/** Client-specific reporting fields (e.g. SAP sync IDs). Never deleted — only deactivated. */
export const clientAdditionalFields = pgTable(
  "client_additional_fields",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id),
    label: varchar("label", { length: 100 }).notNull(),
    scope: additionalFieldScopeEnum("scope").notNull(),
    dataType: additionalFieldDataTypeEnum("data_type")
      .notNull()
      .default("text"),
    displayOrder: smallint("display_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (t) => [
    uniqueIndex("client_additional_fields_client_scope_label_uidx").on(
      t.clientId,
      t.scope,
      sql`lower(${t.label})`,
    ),
  ],
);

/**
 * Values per auction (lot_id NULL) or per lot. Rows present for an auction define
 * which client fields are selected for it; value may be NULL.
 */
export const auctionAdditionalFieldValues = pgTable(
  "auction_additional_field_values",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    auctionId: integer("auction_id")
      .notNull()
      .references(() => auctions.id, { onDelete: "cascade" }),
    lotId: integer("lot_id").references(() => auctionLots.id, {
      onDelete: "cascade",
    }),
    fieldId: integer("field_id")
      .notNull()
      .references(() => clientAdditionalFields.id),
    value: varchar("value", { length: 2000 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (t) => [
    uniqueIndex("auction_additional_field_values_auction_field_uidx")
      .on(t.auctionId, t.fieldId)
      .where(sql`${t.lotId} IS NULL`),
    uniqueIndex("auction_additional_field_values_lot_field_uidx")
      .on(t.lotId, t.fieldId)
      .where(sql`${t.lotId} IS NOT NULL`),
    index("auction_additional_field_values_auction_idx").on(t.auctionId),
  ],
);
