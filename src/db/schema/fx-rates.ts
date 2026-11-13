import {
  date,
  integer,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const fxRates = pgTable(
  "fx_rates",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    base: varchar("base", { length: 3 }).notNull(),
    quote: varchar("quote", { length: 3 }).notNull(),
    rateDate: date("rate_date").notNull(),
    /** 1 unit of `base` = `rate` units of `quote`. */
    rate: numeric("rate", { precision: 18, scale: 6 }).notNull(),
    source: varchar("source", { length: 50 }).notNull().default("frankfurter"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("fx_rates_base_quote_date_uidx").on(
      table.base,
      table.quote,
      table.rateDate,
    ),
  ],
);
