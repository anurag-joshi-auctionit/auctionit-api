/**
 * One-time: populate the new `benchmark_materials` / `benchmark_locations`
 * master tables from the free-text `material`/`location` columns on
 * `benchmark_material_locations`, then backfill that table's new
 * `material_id`/`location_id` FK columns by name match. Uses raw SQL so it
 * works while the old text columns still exist in the database.
 *
 * Run:  pnpm --filter @auctionit/api db:backfill-benchmark-materials-locations
 *       APPLY=1 pnpm --filter @auctionit/api db:backfill-benchmark-materials-locations
 */
import { sql } from "drizzle-orm";
import { db, pool } from "./index.js";
import { formatUtcNow } from "@auctionit/lib/date";

const APPLY = process.env.APPLY === "1" || process.env.APPLY === "true";
const SYSTEM_USER_ID = 1;

async function main() {
  const prefix = APPLY ? "" : "[DRY RUN] ";
  console.log(`\n${prefix}Backfill benchmark_materials / benchmark_locations\n`);

  const now = formatUtcNow();

  const distinctMaterials = await db.execute<{ name: string }>(sql`
    SELECT DISTINCT trim(material) AS name FROM benchmark_material_locations
  `);
  const distinctLocations = await db.execute<{ name: string }>(sql`
    SELECT DISTINCT trim(location) AS name FROM benchmark_material_locations
  `);
  console.log(
    `  Distinct materials: ${distinctMaterials.rows.length}, distinct locations: ${distinctLocations.rows.length}`,
  );

  if (!APPLY) {
    console.log(
      "\n  DRY_RUN — no changes written. Re-run with APPLY=1 to write.\n",
    );
    return;
  }

  await db.transaction(async (tx) => {
    for (const row of distinctMaterials.rows) {
      await tx.execute(sql`
        INSERT INTO benchmark_materials (name, is_active, created_at, created_by, updated_at, updated_by)
        VALUES (${row.name}, true, ${now}, ${SYSTEM_USER_ID}, ${now}, ${SYSTEM_USER_ID})
        ON CONFLICT (lower(name)) DO NOTHING
      `);
    }
    for (const row of distinctLocations.rows) {
      await tx.execute(sql`
        INSERT INTO benchmark_locations (name, is_active, created_at, created_by, updated_at, updated_by)
        VALUES (${row.name}, true, ${now}, ${SYSTEM_USER_ID}, ${now}, ${SYSTEM_USER_ID})
        ON CONFLICT (lower(name)) DO NOTHING
      `);
    }

    await tx.execute(sql`
      UPDATE benchmark_material_locations bml
      SET material_id = bm.id
      FROM benchmark_materials bm
      WHERE lower(trim(bml.material)) = lower(bm.name) AND bml.material_id IS NULL
    `);
    await tx.execute(sql`
      UPDATE benchmark_material_locations bml
      SET location_id = bl.id
      FROM benchmark_locations bl
      WHERE lower(trim(bml.location)) = lower(bl.name) AND bml.location_id IS NULL
    `);
  });

  const unresolved = await db.execute<{ id: number; material: string; location: string }>(sql`
    SELECT id, material, location FROM benchmark_material_locations
    WHERE material_id IS NULL OR location_id IS NULL
  `);
  const duplicates = await db.execute<{ material_id: number; location_id: number; n: number }>(sql`
    SELECT material_id, location_id, count(*)::int AS n
    FROM benchmark_material_locations
    GROUP BY material_id, location_id
    HAVING count(*) > 1
  `);

  const materialCount = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM benchmark_materials`);
  const locationCount = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM benchmark_locations`);

  console.log(`\n  benchmark_materials rows: ${materialCount.rows[0]?.n}`);
  console.log(`  benchmark_locations rows: ${locationCount.rows[0]?.n}`);
  console.log(`  Unresolved combo rows: ${unresolved.rows.length}`);
  console.log(`  Duplicate (material_id, location_id) pairs: ${duplicates.rows.length}`);

  if (unresolved.rows.length > 0) {
    console.error("\n  Unresolved rows (manual fix required before Phase 2 push):");
    for (const r of unresolved.rows) {
      console.error(`    #${r.id}  material=${JSON.stringify(r.material)}  location=${JSON.stringify(r.location)}`);
    }
    process.exitCode = 1;
  }

  if (duplicates.rows.length > 0) {
    console.error(
      "\n  Duplicate (material_id, location_id) pairs found — case/whitespace variants of two legacy\n" +
        "  strings collapsed onto the same master row(s). Resolve manually (merge or deactivate the\n" +
        "  extra combo row(s)) before the Phase 2 push, which will add a unique constraint on this pair:",
    );
    for (const d of duplicates.rows) {
      console.error(`    material_id=${d.material_id} location_id=${d.location_id} count=${d.n}`);
    }
    process.exitCode = 1;
  }

  if (!process.exitCode) {
    console.log("\n  Done — safe to proceed to the Phase 2 schema push.\n");
  }
}

main()
  .catch((e) => {
    console.error("Backfill failed:", e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
