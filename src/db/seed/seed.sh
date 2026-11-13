#!/usr/bin/env bash
# Run Postgres seeds in dependency order (see seed-commands.txt).
#
# Usage (from repo root or apps/api):
#   ./src/db/seed/seed.sh                  # DB phases (A–C) + file/R2 phase
#   ./src/db/seed/seed.sh --db-only        # DB phases (A–C) only, no R2 uploads
#   ./src/db/seed/seed.sh --files-only     # only file/document uploads to R2
#   ./src/db/seed/seed.sh --clean          # dry-run row counts only
#   ./src/db/seed/seed.sh --clean-yes      # truncate default tables, then seed
#
# Phase A (Postgres-only) does not require MSSQL env vars.
# Phases B–C require MSSQL_* in .env — see seed-commands.txt.
# Phase R2 (file/document uploads) requires MSSQL_* + R2 credentials.
#
# After each seed, the console reprints the seed label with:
#   ✅  all pulled MSSQL rows upserted (no skips)
#   ⚠️  one or more source rows were skipped
#   ❌  seed process failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$API_ROOT"

CLEAN_MODE=""
# Which phases to run: "all" (DB + files), "db" (DB only), "files" (R2 only).
SEED_MODE="all"
# Optional R2 bucket override for the file phase (e.g. auctionit-staging).
R2_BUCKET_OVERRIDE=""
SEED_WARNINGS=0
SEED_FAILURES=0

usage() {
  cat <<'EOF'
Usage: seed.sh [OPTIONS]

Run database seeds in dependency order. By default runs the DB phases
(A → C) followed by the file/document upload phase (R2).

Options:
  --db-only     Run DB phases (A–C) only; skip file/document R2 uploads
  --files-only  Run only file/document uploads to R2 (bidder + auction + SI docs)
  --clean       Dry-run clean (prints row counts, deletes nothing)
  --clean-yes   Truncate default seed tables, then run seeds
  --r2-bucket <name>  Upload files to this R2 bucket (overrides R2_BUCKET),
                      e.g. auctionit-local or auctionit-staging
  -h, --help    Show this help

Phase A (Postgres-only): no MSSQL required.
Phases B–C: require MSSQL_SERVER / MSSQL_PORT / MSSQL_USER / MSSQL_PASSWORD / MSSQL_DATABASE.
Phase R2: requires MSSQL_* (above) plus R2 credentials.

Notes:
  --db-only and --files-only are mutually exclusive.
  --clean / --clean-yes are ignored with --files-only (no tables to truncate).
  Run the DB phases before --files-only so bidders/auctions exist for the uploads.

Status markers (printed after each seed):
  ✅  every pulled row upserted — nothing skipped
  ⚠️  at least one row was skipped
  ❌  seed exited with an error
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db-only)
      SEED_MODE="db"
      shift
      ;;
    --files-only)
      SEED_MODE="files"
      shift
      ;;
    --clean)
      CLEAN_MODE="dry-run"
      shift
      ;;
    --clean-yes)
      CLEAN_MODE="yes"
      shift
      ;;
    --r2-bucket)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "--r2-bucket requires a bucket name" >&2
        exit 1
      fi
      R2_BUCKET_OVERRIDE="$2"
      shift 2
      ;;
    --r2-bucket=*)
      R2_BUCKET_OVERRIDE="${1#*=}"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -n "$R2_BUCKET_OVERRIDE" ]]; then
  export R2_BUCKET="$R2_BUCKET_OVERRIDE"
  echo "Using R2 bucket: $R2_BUCKET"
fi

# Returns 0 if seed log indicates any skipped / failed-to-migrate source rows.
seed_output_has_skips() {
  local file="$1"
  python3 - "$file" <<'PY'
import re
import sys

text = open(sys.argv[1], encoding="utf-8", errors="replace").read()

# Prefer an explicit machine marker if a seed prints one.
m = re.search(r"^SEED_OUTCOME\s+(\S+)(?:\s+skipped=(\d+))?\s*$", text, re.M)
if m:
    kind = m.group(1).lower()
    skipped = int(m.group(2) or "0")
    sys.exit(0 if kind in {"warn", "skipped"} or skipped > 0 else 1)

# Upserted X / Y source rows — warn when not all made it.
for m in re.finditer(r"(?i)Upserted\s+(\d+)\s*/\s*(\d+)", text):
    if int(m.group(1)) < int(m.group(2)):
        sys.exit(0)

patterns = [
    # "skipped 12", "skipped 12 without…", "part1 skipped 3"
    r"(?i)\bskipped\s+([1-9]\d*)\b",
    # "12 skipped", "12 skipped:", "12 skipped missing client"
    r"(?i)\b([1-9]\d*)\s+skipped\b",
    # "3 kam_id skipped invalid user"
    r"(?i)\b([1-9]\d*)\s+\S+\s+skipped\b",
    # "(5 price rows skipped)"
    r"(?i)\(([1-9]\d*)\s+price rows skipped\)",
    # migrate / upload failures
    r"(?i)migrate failed\s+([1-9]\d*)",
    r"(?i)\b([1-9]\d*)\s+missing legacy file\b",
    r"(?i)\b([1-9]\d*)\s+upload errors?\b",
    # per-row skip warnings
    r"(?i)Skipped\s+RecId=",
    r"(?i)\*\*\*\s*WARN:.*\bSkipped\s+([1-9]\d*)",
]

for pat in patterns:
    if re.search(pat, text):
        sys.exit(0)

sys.exit(1)
PY
}

run() {
  echo ""
  local label="$*"
  echo "==> $label"
  local tmp
  tmp="$(mktemp)"
  local exit_code=0

  set +e
  pnpm "$@" 2>&1 | tee "$tmp"
  exit_code=${PIPESTATUS[0]}
  set -e

  if [[ $exit_code -ne 0 ]]; then
    echo "==> $label ❌"
    SEED_FAILURES=$((SEED_FAILURES + 1))
    rm -f "$tmp"
    exit "$exit_code"
  fi

  # clean:db is not an MSSQL upsert seed — success only.
  if [[ "$label" == clean:db* ]]; then
    echo "==> $label ✅"
    rm -f "$tmp"
    return 0
  fi

  if seed_output_has_skips "$tmp"; then
    echo "==> $label ⚠️"
    SEED_WARNINGS=$((SEED_WARNINGS + 1))
  else
    echo "==> $label ✅"
  fi
  rm -f "$tmp"
}

run_db_phases() {
  if [[ "$CLEAN_MODE" == "dry-run" ]]; then
    run clean:db
  elif [[ "$CLEAN_MODE" == "yes" ]]; then
    run clean:db --yes
  fi

  echo ""
  echo "=== Phase A — Postgres-only reference data ==="

  run seed:locations
  run seed:roles
  # System user id=1 so Phase A seeds (and permissions) can set created_by / updated_by.
  run seed:bootstrap-user
  run seed:backfill-audit-actors
  run seed:permissions
  run seed:materials
  run seed:sms-templates
  run seed:client-document-types
  run seed:auction-document-types
  run seed:service-invoice-document-types
  run seed:subscription-document-types

  echo ""
  echo "=== Phase B — MSSQL → Postgres core ==="
  # Always after seed:roles (+ seed:permissions): remaps role_id from MSSQL flags
  # and dedupes email_id (required before users_email_id_lower_uidx).

  run seed:users
  run seed:clients
  run seed:plant-locations
  run seed:material-locations
  run seed:uom
  run seed:items
  run seed:service-invoices
  run seed:service-invoice-payment-logs
  run seed:benchmarks
  run seed:validate-clients
  run seed:bidders
  run seed:bidder-registrations
  run seed:user-clients
  run seed:user-bidders
  run seed:bidder-blocks
  run seed:client-bidders
  run seed:bidder-exemptions
  run seed:bidder-document-types
  run seed:bidder-bank-accounts
  run seed:subscription-types
  run seed:payment-types
  run seed:subscriptions
  run seed:subscription-payment-requests

  echo ""
  echo "=== Phase C — MSSQL → Postgres dependent ==="

  run seed:auctions
  run seed:auction-lots
  run seed:auction-bids
  run seed:auction-bid-logs
  run seed:auction-sealed-bids
  run seed:backfill-lot-bid-stats
  run seed:lifting-dispositions
  run seed:lifting-client-log
  run seed:backfill-auctionlot-approval
  run seed:backfill-latest-lifted
  run seed:auction-lot-bidder-maps
  run seed:client-bidders
  run seed:auction-lot-emd
  run seed:auction-additional-fields
  run seed:emd
  run seed:analyze
  run emd:verify-seed
  run emd:verify-holds
}

run_files_phase() {
  echo ""
  echo "=== Phase R2 — file/document uploads to R2 ==="

  # seed:bidder-documents self-backfills bidder_bank_accounts.cancelled_cheque_file_name,
  # so it is safe to run after seed:bidder-bank-accounts (Phase B).
  run seed:bidder-documents
  run seed:auction-documents
  run seed:service-invoice-documents
  run seed:subscription-documents
}

case "$SEED_MODE" in
  db)
    run_db_phases
    ;;
  files)
    run_files_phase
    ;;
  all)
    run_db_phases
    run_files_phase
    ;;
esac

echo ""
if [[ "$SEED_WARNINGS" -gt 0 ]]; then
  echo "All seeds finished with ${SEED_WARNINGS} warning(s) (one or more rows skipped) ⚠️"
else
  echo "All seeds completed successfully ✅"
fi
