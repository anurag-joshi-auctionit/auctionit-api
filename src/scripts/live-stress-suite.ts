import { writeFileSync } from "node:fs";
import { pool } from "../db/index.js";
import {
  configFromEnv,
  evaluateThresholds,
  printReport,
  printThresholds,
  runStress,
  thresholdsFromEnv,
  verdictOf,
  type StressConfig,
  type StressResult,
} from "./live-stress-test.js";

/**
 * Runs the concentration matrix back to back and prints one comparison table.
 *
 * A single number ("can we do 500 bids/sec?") is meaningless on this engine,
 * because bids on the same lot serialize on a `SELECT … FOR UPDATE` row lock
 * while bids on different lots run in parallel. The same 500/sec is therefore
 * either fine or fatal depending purely on how the load is spread. The suite
 * holds the total rate constant and varies only the spread.
 *
 * Run (after seed:stress-auctions AUCTIONS=10 LOTS=10):
 *
 *   TARGET_RPS=500 DURATION_SEC=20 pnpm --filter @auctionit/api live:stress-suite
 *
 * Extra config on top of live:stress:
 *   SETTLE_SEC   quiet gap between scenarios, letting the pool drain (default: 5)
 *   JSON_OUT     path to write every scenario result as JSON
 */

type Scenario = {
  name: string;
  detail: string;
  overrides: Partial<StressConfig>;
};

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

const fmt = (n: number, digits = 1) =>
  Number.isFinite(n) ? n.toFixed(digits) : "—";

const SCENARIOS: Scenario[] = [
  {
    name: "A · single hot lot",
    detail: "all load on one lot — worst case for the per-lot row lock",
    overrides: { auctionLimit: 1, lotsPerAuction: 1 },
  },
  {
    name: "B · 10 auctions × 1 hot lot",
    detail: "the stated scenario: 10 concurrent auctions, one live lot each",
    overrides: { auctionLimit: 10, lotsPerAuction: 1 },
  },
  {
    name: "C · 10 auctions × 10 lots",
    detail: "same total rate spread thin — best case for lock parallelism",
    overrides: { auctionLimit: 10, lotsPerAuction: 10 },
  },
];

async function main() {
  const base = configFromEnv({ quiet: true });
  const settleSec = num(process.env.SETTLE_SEC, 5);
  const thresholds = thresholdsFromEnv();
  let anyFailed = false;

  console.log("\n⚡ Live bid stress suite\n");
  console.log(
    `  Holding ${base.targetRps} bids/sec for ${base.durationSec}s per scenario,` +
      ` varying only how the load is spread.\n`,
  );

  const results: { scenario: Scenario; result: StressResult }[] = [];

  for (const scenario of SCENARIOS) {
    console.log(`\n${"─".repeat(72)}`);
    console.log(`  ${scenario.name}`);
    console.log(`  ${scenario.detail}`);
    console.log(`${"─".repeat(72)}`);

    const cfg: StressConfig = {
      ...base,
      ...scenario.overrides,
      label: scenario.name,
      quiet: false,
    };
    const result = await runStress(cfg);
    printReport(result);
    if (!printThresholds(evaluateThresholds(result, thresholds))) {
      anyFailed = true;
    }
    console.log("");
    results.push({ scenario, result });

    if (settleSec > 0 && scenario !== SCENARIOS[SCENARIOS.length - 1]) {
      console.log(`  Settling for ${settleSec}s…\n`);
      await new Promise((r) => setTimeout(r, settleSec * 1000));
    }
  }

  console.log(`\n${"═".repeat(96)}`);
  console.log("  SUMMARY");
  console.log(`${"═".repeat(96)}\n`);
  const head =
    "  Scenario".padEnd(30) +
    "lots".padStart(6) +
    "per-lot/s".padStart(11) +
    "done/s".padStart(9) +
    "ok/s".padStart(8) +
    "p50".padStart(9) +
    "p99".padStart(10) +
    "errors".padStart(8);
  console.log(head);
  console.log(`  ${"─".repeat(92)}`);
  for (const { scenario, result } of results) {
    console.log(
      `  ${scenario.name}`.padEnd(30) +
        String(result.targets.lots).padStart(6) +
        fmt(result.config.targetRps / result.targets.lots).padStart(11) +
        fmt(result.throughput.completedRps, 0).padStart(9) +
        fmt(result.throughput.acceptedRps, 0).padStart(8) +
        `${fmt(result.latency.p50, 0)}ms`.padStart(9) +
        `${fmt(result.latency.p99, 0)}ms`.padStart(10) +
        String(result.outcomes.errored).padStart(8),
    );
  }

  console.log("\n  Verdicts:");
  for (const { scenario, result } of results) {
    console.log(`    ${scenario.name.padEnd(28)} ${verdictOf(result)}`);
  }
  console.log("");

  if (process.env.JSON_OUT) {
    writeFileSync(
      process.env.JSON_OUT,
      JSON.stringify(
        results.map(({ scenario, result }) => ({
          scenario: scenario.name,
          detail: scenario.detail,
          result,
        })),
        null,
        2,
      ),
    );
    console.log(`  Wrote ${process.env.JSON_OUT}\n`);
  }

  await pool.end();
  process.exit(anyFailed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("\nStress suite failed:", e);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
