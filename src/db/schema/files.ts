import { integer, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const files = pgTable("files", {
    //identity
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    //file
    filename: varchar("filename", { length: 255 }).notNull(),
    s3Key: varchar("s3_key", { length: 500 }).notNull().unique(),

    //audit
    uploadedBy: integer("uploaded_by")
        .notNull()
        .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});
