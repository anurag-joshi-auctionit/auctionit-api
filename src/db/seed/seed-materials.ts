import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { env } from "../../env.js";
import { SEED_DEFAULT_USER_ID } from "./audit-user.js";

const CSV_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "data",
  "materials.csv",
);

const INSERT_SQL = `
INSERT INTO materials (label, parent_id, depth, is_active, created_at, created_by, updated_at, updated_by)
VALUES ($1, $2, $3, true, NOW(), $4, NOW(), $4)
RETURNING id
`;

type MaterialNode = {
  /** Stable hierarchical path key, used to resolve parent ids during seeding. */
  path: string;
  parentPath: string | null;
  label: string;
  depth: number;
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

/**
 * Builds a self-referential material hierarchy from the flat
 * level1/level2/level3 CSV. Each node carries a hierarchical path key so the
 * seeder can resolve generated integer parent ids. Nodes are returned ordered
 * by depth so parents are inserted before children.
 */
function loadMaterialsFromCsv(): MaterialNode[] {
  const raw = readFileSync(CSV_PATH, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) {
    throw new Error(`Expected header + data rows in ${CSV_PATH}`);
  }

  const headers = parseCsvRow(lines[0]!).map((h) => h.replace(/^﻿/, "").trim());
  const expected = ["level1", "level2", "level3"];
  for (let i = 0; i < expected.length; i++) {
    if (headers[i] !== expected[i]) {
      throw new Error(
        `Unexpected header in ${CSV_PATH}: got [${headers.join(", ")}], expected [${expected.join(", ")}]`,
      );
    }
  }

  const byDepth: Map<string, MaterialNode>[] = [new Map(), new Map(), new Map()];

  for (let r = 1; r < lines.length; r++) {
    const cells = parseCsvRow(lines[r]!);
    const levels = [
      (cells[0] ?? "").trim(),
      (cells[1] ?? "").trim(),
      (cells[2] ?? "").trim(),
    ];
    if (!levels[0]) continue;

    let parentPath: string | null = null;
    let path = "";
    for (let depth = 1; depth <= levels.length; depth++) {
      const label = levels[depth - 1];
      if (!label) break;
      path = path ? `${path}\u0000${label}` : label;
      const map = byDepth[depth - 1]!;
      if (!map.has(path)) {
        map.set(path, { path, parentPath, label, depth });
      }
      parentPath = path;
    }
  }

  return byDepth.flatMap((map) => Array.from(map.values()));
}

async function main() {
  const started = Date.now();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const nodes = loadMaterialsFromCsv();
    console.log(`Loaded ${nodes.length} material nodes from materials.csv.`);

    if (nodes.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    const client = await pgPool.connect();
    const idByPath = new Map<string, number>();
    let inserted = 0;
    try {
      await client.query("BEGIN");
      // Identity ids regenerate on each run, so reset for an idempotent reseed.
      // CASCADE is required because dependent tables (e.g. items) FK to materials;
      // materials is seeded before those tables, so cascading truncation is safe.
      await client.query("TRUNCATE TABLE materials RESTART IDENTITY CASCADE");

      for (const node of nodes) {
        const parentId = node.parentPath
          ? (idByPath.get(node.parentPath) ?? null)
          : null;
        const res = await client.query<{ id: number }>(INSERT_SQL, [
          node.label,
          parentId,
          node.depth,
          SEED_DEFAULT_USER_ID,
        ]);
        idByPath.set(node.path, res.rows[0]!.id);
        inserted++;
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `Inserted ${inserted} rows into materials in ${Date.now() - started}ms.`,
    );
  } finally {
    await pgPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
