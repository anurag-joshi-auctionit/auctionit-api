import { integer, pgTable, uniqueIndex, varchar } from "drizzle-orm/pg-core";

export const locations = pgTable(
    "locations",
    {
        //identity
        id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

        //location
        country: varchar("country", { length: 100 }).notNull(),
        state: varchar("state", { length: 100 }).notNull(),
        city: varchar("city", { length: 100 }).notNull(),
    },
    (table) => [
        uniqueIndex("locations_country_state_city_uidx").on(
            table.country,
            table.state,
            table.city,
        ),
    ],
);
