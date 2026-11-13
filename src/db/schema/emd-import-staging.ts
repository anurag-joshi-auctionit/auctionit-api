import { integer, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/** Temporary bank statement import sessions held between preview and confirm. */
export const emdImportStagingSessions = pgTable("emd_import_staging_sessions", {
  id: uuid("id").defaultRandom().primaryKey().notNull(),
  payload: jsonb("payload").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  createdBy: integer("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});
