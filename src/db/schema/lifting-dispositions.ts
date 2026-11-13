import {
  boolean,
  integer,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

/** Fixed ids 1–5 map to `lifting_status` ints on `lifting_client_logs`. */
export const liftingClientDispositions = pgTable(
  "lifting_client_dispositions",
  {
    id: integer("id").primaryKey().notNull(),
    label: varchar("label", { length: 128 }).notNull(),
    description: varchar("description", { length: 500 }).notNull().default(""),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    createdBy: integer("created_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
);

export const liftingBidderDispositions = pgTable(
  "lifting_bidder_dispositions",
  {
    id: serial("id").primaryKey().notNull(),
    label: varchar("label", { length: 128 }).notNull(),
    description: varchar("description", { length: 500 }).notNull().default(""),
    isActive: boolean("is_active").notNull().default(true),
    requiresLiftedQty: boolean("requires_lifted_qty").notNull().default(false),
    requiresNextFollowup: boolean("requires_next_followup")
      .notNull()
      .default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    createdBy: integer("created_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
);
