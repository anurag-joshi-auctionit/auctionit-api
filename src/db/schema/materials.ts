import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const materials = pgTable("materials", {
  //identity
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  label: text("label").notNull(),

  //status
  isActive: boolean("is_active").notNull().default(true),

  //hierarchy
  parentId: integer("parent_id").references((): AnyPgColumn => materials.id),
  depth: integer("depth").notNull().default(1),

  //audit
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  createdBy: integer("created_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedBy: integer("updated_by").references(() => users.id),
});
