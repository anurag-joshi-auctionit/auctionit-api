import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

export async function nextId(tableName: string, idColumn: string): Promise<number> {
  const result = await db.execute<{ next_id: number }>(
    sql.raw(`SELECT COALESCE(MAX("${idColumn}"), 0) + 1 AS next_id FROM "${tableName}"`),
  );
  const rows = (result as unknown as { rows: Array<{ next_id: number | string }> }).rows;
  return Number(rows[0]?.next_id ?? 1);
}
