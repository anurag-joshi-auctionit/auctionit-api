#!/usr/bin/env bash
# Run ON the staging API host (e.g. 10.10.130.137) with sudo.
# Sets client_max_body_size on the staging.api.auctionit.ai nginx server
# block (not the first unrelated vhost).
#
# Usage:
#   sudo ./scripts/set-nginx-upload-limit.sh 25m
set -euo pipefail

LIMIT="${1:-25m}"
API_SERVER_NAME="${API_SERVER_NAME:-staging.api.auctionit.ai}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Re-run with sudo: sudo $0 ${LIMIT}" >&2
  exit 1
fi

if ! command -v nginx >/dev/null 2>&1; then
  echo "nginx not found on PATH" >&2
  exit 1
fi

echo "=== Before (api server + body size) ==="
nginx -T 2>/dev/null | grep -nE "server_name ${API_SERVER_NAME}|client_max_body_size" | head -40 || true

mapfile -t FILES < <(
  grep -RIlF "server_name ${API_SERVER_NAME}" \
    /etc/nginx/sites-enabled /etc/nginx/sites-available /etc/nginx/conf.d \
    2>/dev/null || true
)

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "No nginx site file contains: server_name ${API_SERVER_NAME}" >&2
  echo "Inspect with: sudo nginx -T | grep -nE 'server_name|client_max_body_size'" >&2
  exit 1
fi

updated=0
for f in "${FILES[@]}"; do
  echo "Patching API server block in: $f"

  python3 - "$f" "$API_SERVER_NAME" "$LIMIT" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
server_name = sys.argv[2]
limit = sys.argv[3]
text = path.read_text()

# Match the server { ... } whose server_name includes our API host.
# Non-greedy body until the matching closing brace at the same depth is hard
# with regex alone; walk braces instead.
needle = re.compile(
    r"server_name\s+([^;]*\b" + re.escape(server_name) + r"\b[^;]*);",
    re.M,
)

match = needle.search(text)
if not match:
    print(f"ERROR: server_name {server_name} not found in {path}", file=sys.stderr)
    sys.exit(2)

# Find the "server {" that opens this block (search backwards from server_name).
before = text[: match.start()]
server_open = None
for m in re.finditer(r"(?m)^([ \t]*)server\s*\{", before):
    server_open = m
if server_open is None:
    print(f"ERROR: could not find server {{ before server_name in {path}", file=sys.stderr)
    sys.exit(2)

start = server_open.start()
indent = server_open.group(1) + "    "
i = server_open.end() - 1  # at '{'
depth = 0
end = None
for j in range(i, len(text)):
    ch = text[j]
    if ch == "{":
        depth += 1
    elif ch == "}":
        depth -= 1
        if depth == 0:
            end = j + 1
            break
if end is None:
    print(f"ERROR: unclosed server block in {path}", file=sys.stderr)
    sys.exit(2)

block = text[start:end]
directive = f"client_max_body_size {limit};"

if re.search(r"client_max_body_size\s+" + re.escape(limit) + r"\s*;", block):
    print(f"OK (already {limit}): {path}")
    sys.exit(0)

if re.search(r"client_max_body_size\s+[^;]+;", block):
    new_block = re.sub(
        r"client_max_body_size\s+[^;]+;",
        directive,
        block,
        count=1,
    )
    print(f"Updated existing client_max_body_size → {limit}")
else:
    # Insert immediately after the opening "server {" line.
    new_block, n = re.subn(
        r"(?m)^(server\s*\{)\s*$",
        rf"\1\n{indent}{directive}",
        block,
        count=1,
    )
    if n != 1:
        # Fallback: after server_name line
        new_block, n = re.subn(
            r"(server_name\s+[^;]*" + re.escape(server_name) + r"[^;]*;)",
            rf"\1\n{indent}{directive}",
            block,
            count=1,
        )
    if n != 1:
        print(f"ERROR: failed to insert directive into {path}", file=sys.stderr)
        sys.exit(2)
    print(f"Inserted {directive} into server_name {server_name} block")

path.write_text(text[:start] + new_block + text[end:])
PY

  updated=$((updated + 1))
done

if [[ "$updated" -eq 0 ]]; then
  echo "No files patched." >&2
  exit 1
fi

nginx -t
systemctl reload nginx

echo
echo "=== After (api server + body size) ==="
nginx -T 2>/dev/null | grep -nE "server_name ${API_SERVER_NAME}|client_max_body_size" | head -40 || true

echo
echo "Verify (expect 401/400, NOT 413):"
echo "  dd if=/dev/zero of=/tmp/big.pdf bs=1024 count=1500"
echo "  curl -s -o /dev/null -w '%{http_code}\\n' -X POST http://${API_SERVER_NAME}/auctions/1/documents -F 'file=@/tmp/big.pdf;type=application/pdf' -F documentTypeId=1"
