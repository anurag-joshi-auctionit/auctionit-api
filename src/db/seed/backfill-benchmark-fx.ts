/**
 * One-time: marks USD benchmark combos, loads USD/INR rates from Frankfurter
 * into `fx_rates`, and fills currency / exchange_rate / price_inr / rate_date
 * on every `benchmark_prices` row.
 *
 *   pnpm db:backfill-benchmark-fx [--delete-junk]
 *
 * `--delete-junk` removes prices dated before ECB coverage (legacy
 * `1899-12-31` rows), which can never be rated.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../index.js";
import {
  rateBenchmarkPrices,
  nonInrPriceDateRange,
} from "../../services/benchmark-price-rating.js";
import { fxRatesService } from "../../services/fx-rates.service.js";

const ECB_FIRST_DATE = "1999-01-04";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const deleteJunk = process.argv.includes("--delete-junk");
  const started = Date.now();

  const marked = await db.execute<{ id: number; material: string; location: string }>(sql`
    UPDATE benchmark_material_locations bml
    SET currency = 'USD'
    FROM benchmark_locations bl
    WHERE bml.location_id = bl.id AND bl.name LIKE '%$%' AND bml.currency <> 'USD'
    RETURNING bml.id, (SELECT bm.name FROM benchmark_materials bm WHERE bm.id = bml.material_id) AS material, bl.name AS location
  `);
  const usdCombos = await db.execute<{ id: number; material: string; location: string }>(sql`
    SELECT bml.id, bm.name AS material, bl.name AS location
    FROM benchmark_material_locations bml
    JOIN benchmark_materials bm ON bm.id = bml.material_id
    JOIN benchmark_locations bl ON bl.id = bml.location_id
    WHERE bml.currency = 'USD'
    ORDER BY bm.name, bl.name
  `);
  console.log(
    `Marked ${marked.rowCount ?? 0} combo(s) as USD. USD combos now: ${usdCombos.rows.length}`,
  );
  for (const c of usdCombos.rows) {
    console.log(`  #${c.id}  ${c.material} | ${c.location}`);
  }

  if (deleteJunk) {
    const deleted = await db.execute(sql`
      DELETE FROM benchmark_prices WHERE benchmark_date < ${ECB_FIRST_DATE}::date
    `);
    console.log(`Deleted ${deleted.rowCount ?? 0} junk price row(s) dated before ${ECB_FIRST_DATE}.`);
  }

  for (const range of await nonInrPriceDateRange()) {
    const to = range.to > todayIso() ? todayIso() : range.to;
    const loaded = await fxRatesService.loadRange(range.currency, range.from, to);
    console.log(`Loaded ${loaded} ${range.currency}/INR rate(s) for ${range.from}..${to}.`);
  }

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = 0`);
    return rateBenchmarkPrices({}, tx);
  });

  console.log(
    `Rated benchmark prices: ${result.inrRows} INR row(s), ` +
      `${result.convertedRows} converted row(s), ${result.unratedRows} unrated ` +
      `in ${Date.now() - started}ms.`,
  );
  if (result.unratedRows > 0) {
    const sample = await db.execute<{ location: string; benchmark_date: string; n: number }>(sql`
      SELECT bl.name AS location, to_char(bp.benchmark_date, 'YYYY-MM-DD') AS benchmark_date, count(*)::int AS n
      FROM benchmark_prices bp
      JOIN benchmark_material_locations bml ON bml.id = bp.benchmark_material_location_id
      JOIN benchmark_locations bl ON bl.id = bml.location_id
      WHERE bml.currency <> 'INR'
        AND (bp.currency <> bml.currency OR bp.price_inr IS NULL)
      GROUP BY 1, 2
      ORDER BY 2
      LIMIT 20
    `);
    console.warn("Unrated rows (first 20 groups):");
    console.table(sample.rows);
    if (!deleteJunk) {
      console.warn("Re-run with --delete-junk to drop rows dated before ECB coverage.");
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
