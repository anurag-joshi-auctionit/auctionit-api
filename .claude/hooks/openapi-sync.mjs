#!/usr/bin/env node
// PostToolUse hook: after Claude edits an API route, request schema or docs
// file, regenerate openapi.json and run the drift check. Problems are
// reported back to Claude (exit 2 + stderr) so it fixes the docs in the same
// change. Unrelated edits exit immediately.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RELEVANT =
  /(^|\/)src\/(routes\/|openapi\/|auth\/middleware\.ts|lib\/.*schema[^/]*\.ts|lib\/options-query\.ts)/;

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const file = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path ?? "";
if (!RELEVANT.test(file) || /\.test\.ts$/.test(file)) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const run = (script) =>
  execFileSync("pnpm", ["--silent", script], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 90_000,
  });

try {
  run("openapi:generate");
  run("openapi:check");
} catch (err) {
  const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
  process.stderr.write(
    `API docs are out of sync with the code (see docs/api/README.md):\n${out.slice(-4000)}\n` +
      "Update src/openapi/paths/<router>.ts (and responses/) for the routes above.\n",
  );
  process.exit(2);
}
process.exit(0);
