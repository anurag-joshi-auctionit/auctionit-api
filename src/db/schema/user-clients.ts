import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
} from "drizzle-orm/pg-core";
import { clients } from "./clients.js";
import { users } from "./users.js";

// Many-to-many between login users and client companies. Holds both:
//   - client / client_limited portal memberships (legacy tbl_Config_ClientCompUser)
//   - KAM / service-provider client scope (legacy tbl_Config_Client_ServiceProvider_Map)
// Role on users discriminates portal vs KAM; this table is membership only.
export const userClients = pgTable(
  "user_clients",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id),

    isActive: boolean("is_active").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    createdBy: integer("created_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.clientId] }),
    index("user_clients_client_id_idx").on(table.clientId),
  ],
);
