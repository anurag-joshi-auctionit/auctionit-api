import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { env } from "../../env.js";

const CSV_PATH = join(dirname(fileURLToPath(import.meta.url)), "data", "cities.csv");
const COUNTRY = "India";

const UPSERT_SQL = `
INSERT INTO locations (country, state, city)
SELECT * FROM UNNEST($1::varchar[], $2::varchar[], $3::varchar[])
ON CONFLICT (country, state, city) DO UPDATE SET
  country = EXCLUDED.country,
  state = EXCLUDED.state,
  city = EXCLUDED.city
`;

type LocationRow = {
  country: string;
  state: string;
  city: string;
};

/** RFC 4180-style row parse (handles quoted commas). */
function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function locationKey(row: LocationRow): string {
  return `${row.country}\0${row.state}\0${row.city}`;
}

function dedupeByLocation(rows: LocationRow[]): LocationRow[] {
  const map = new Map<string, LocationRow>();
  for (const r of rows) {
    const key = locationKey(r);
    if (!map.has(key)) map.set(key, r);
  }
  return Array.from(map.values());
}

function loadLocationsFromCsv(): LocationRow[] {
  const raw = readFileSync(CSV_PATH, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) {
    throw new Error(`Expected header + data rows in ${CSV_PATH}`);
  }

  const headers = parseCsvRow(lines[0]!).map((h) => h.replace(/^\uFEFF/, "").trim());
  const rows: LocationRow[] = [];

  for (let r = 1; r < lines.length; r++) {
    const cells = parseCsvRow(lines[r]!);
    for (let c = 0; c < headers.length; c++) {
      const state = headers[c];
      const city = (cells[c] ?? "").trim();
      if (!state || !city) continue;
      rows.push({ country: COUNTRY, state, city });
    }
  }

  return dedupeByLocation(rows);
}

async function main() {
  const started = Date.now();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const deduped = loadLocationsFromCsv();
    console.log(`Loaded ${deduped.length} unique India locations from cities.csv.`);

    if (deduped.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    const CHUNK = 500;
    let upserted = 0;
    for (let i = 0; i < deduped.length; i += CHUNK) {
      const batch = deduped.slice(i, i + CHUNK);
      await pgPool.query(UPSERT_SQL, [
        batch.map((r) => r.country),
        batch.map((r) => r.state),
        batch.map((r) => r.city),
      ]);
      upserted += batch.length;
    }
    console.log(
      `Upserted ${upserted} rows into locations in ${Date.now() - started}ms.`,
    );
  } finally {
    await pgPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
