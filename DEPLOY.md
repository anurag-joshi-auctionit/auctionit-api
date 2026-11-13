# Deploy

Operational notes for running the API on a single Ubuntu host (current testers' box: `10.10.130.137`). It runs under `pm2`; the workflow is `git pull` → restart.

Replace `10.10.130.137` with whatever IP/hostname your box answers on.

## API — `@auctionit/api`

### `.env`

```env
DATABASE_URL=postgres://admin:MilkyWay%40123@10.10.130.137:5432/auction_db
PORT=4000
CORS_ORIGINS=http://10.10.130.137:3001,http://10.10.130.137:3002,http://localhost:3001,http://localhost:3002
NODE_ENV=production
TRUST_PROXY=true
```

- The `@` in the DB password must be URL-encoded as `%40`. Some drivers split on the first `@` and break otherwise.
- `TRUST_PROXY=true` is **required** whenever the API sits behind nginx / a load balancer. It makes `req.ip` use the `X-Forwarded-For` header set by the proxy (see the nginx example below). Without it every request appears to come from the proxy's IP, and auctions with **IP Address Restriction** enabled would block every bidder after the first (one IP may only be used by one bidder per auction). It trusts exactly one proxy hop; add another hop (e.g. Cloudflare in front of nginx) only after updating `app.set("trust proxy", …)` in `src/index.ts`.
- `CORS_ORIGINS` is a comma-separated allow-list. Every browser origin (admin/app/marketing) must appear here, or the browser will reject responses with a CORS error.
- **Accounts users** sign in at the admin app (`:3001` / `admin.auctionit.ai`). Accounts workflow routes live under `/accounts/*` in the same SPA.
- **Bidder and client users** share the external portal app (`:3002` / `app.auctionit.ai`).
- Set `APP_BASE_URL` to the external portal origin (used for Instamojo payment return URLs and bidder notification emails). Defaults to `http://localhost:3002`.
- After upgrading an existing DB, enable the new `module.portal-*` permission keys for `bidder` / `client` roles in Admin → Permissions, or re-run `pnpm seed:permissions` on a dev/staging database.

> EMD one-off and repair scripts: see [docs/ops/emd-one-off-scripts.md](docs/ops/emd-one-off-scripts.md) for what to run and when.

### First-time DB setup

```bash
# baseline existing migrations (only first time, against a DB that already
# has the migrated MSSQL schema)
pnpm db:baseline
pnpm db:migrate    # no-op now; future migrations apply here

# verify
psql "$(grep ^DATABASE_URL .env | cut -d= -f2-)" \
  -c "SELECT id, left(hash,12), to_timestamp(created_at/1000) FROM drizzle.__drizzle_migrations ORDER BY id;"
```

### Reverse proxy body size (document uploads)

Auction / client / bidder document uploads use **multipart** (not base64 JSON). If you put nginx, Caddy, Cloudflare Tunnel, or another reverse proxy in front of the API, set the request body limit to at least **25m** so app-level caps (catalogue/TnC 5 MB, client/bidder docs 10 MB) are reachable.

Without this, nginx’s default **1m** limit returns **413 Request Entity Too Large** for files above ~1 MB. The browser often surfaces that as a CORS / “Failed to fetch” toast because the 413 HTML response has no `Access-Control-Allow-Origin` header.

#### nginx on `staging.api.auctionit.ai` (host `10.10.130.137`)

```bash
ssh <user>@10.10.130.137

# Option A — helper script (from the repo on the server)
cd ~/auctionit-api
git pull
sudo ./scripts/set-nginx-upload-limit.sh 25m

# Option B — manual: find the vhost that proxies to the API on :4000
sudo nginx -T 2>/dev/null | grep -nE 'server_name|staging\.api|client_max_body_size|proxy_pass|4000'
# or: sudo grep -RInE 'staging\.api|4000' /etc/nginx/sites-enabled/ /etc/nginx/conf.d/
```

If editing by hand, in the `server { ... }` block for `staging.api.auctionit.ai`, add:

```nginx
client_max_body_size 25m;
```

Example:

```nginx
server {
    server_name staging.api.auctionit.ai;
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Apply and verify (no `pm2 restart` needed):

```bash
sudo nginx -t && sudo systemctl reload nginx

dd if=/dev/zero of=/tmp/big.pdf bs=1024 count=1500 2>/dev/null
curl -s -o /tmp/upload-body.txt -w "HTTP %{http_code}\n" \
  -X POST "http://staging.api.auctionit.ai/auctions/1/documents" \
  -F "file=@/tmp/big.pdf;type=application/pdf" \
  -F "documentTypeId=1"
# Expect 401/400 from Express — NOT 413
```

Apply the same `client_max_body_size 25m;` on production API hosts if they terminate uploads the same way.

| Proxy | Setting |
|-------|---------|
| **Caddy** | `request_body { max_size 25MB }` |
| **Traefik** | buffering / max request body ≥ 25MB |

### Start under pm2

```bash
pm2 start "pnpm dev" \
  --cwd ~/auctionit-api \
  --name auctionit-api
pm2 start "pnpm dev:email-worker" \
  --cwd ~/auctionit-api \
  --name auctionit-email-worker
pm2 save
pm2 logs auctionit-api --lines 20             # expect: api listening on http://localhost:4000
pm2 logs auctionit-email-worker --lines 20    # expect: email worker starting (batch=…, rate=…/s)
```

Register both once. `pm2 restart all` only restarts processes already in the list — it never creates missing ones — so if the worker was never `pm2 start`ed it will stay down and queued emails will never send.

Locally `pnpm dev:all` starts the API and the email worker together (via `npm-run-all`). pm2 runs them as two separate processes instead (`pnpm dev` and `pnpm dev:email-worker`), so both must be registered.

### Redeploy

```bash
cd ~/auctionit-api
git pull
pnpm install                                  # only if package.json changed
pnpm db:migrate                               # only if drizzle/ changed
pm2 restart auctionit-api auctionit-email-worker
```

### Switching to a compiled build (recommended later)

`tsx watch` + pm2 occasionally collides on port 4000 (EADDRINUSE) when the watcher restarts. The fix is to run the compiled JS:

```bash
pnpm build                                     # tsc → dist/
pm2 delete auctionit-api auctionit-email-worker
pm2 start dist/index.js \
  --cwd ~/auctionit-api \
  --name auctionit-api
pm2 start dist/workers/email-worker.js \
  --cwd ~/auctionit-api \
  --name auctionit-email-worker
pm2 save
# redeploy:
pnpm build && pm2 restart auctionit-api auctionit-email-worker
```

Move both at the same time — the worker under `tsx watch` restarts itself on every file change, which fights pm2's own supervision and can leave orphans holding a DB connection.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `EADDRINUSE: address already in use :::<port>` | A previous process (often a `tsx watch` orphan) is holding the port | `sudo fuser -k <port>/tcp && pm2 delete <name> && pm2 start …` |
| Browser shows CORS error: `Access-Control-Allow-Origin: http://...:3001` doesn't match `http://...:3002` | External portal origin missing from `CORS_ORIGINS` | Add it to `.env`, `pm2 restart auctionit-api` |
| `db:migrate` tries to re-apply 0000 and fails | `__drizzle_migrations` table not seeded for an already-populated DB | Run `pnpm db:baseline` once |
| `drizzle-kit pull` reports `0 tables` | URL parser is confused by an unencoded `@` in the password | Encode `@` as `%40` in `DATABASE_URL` |
| Emails queue up but never send; API itself is healthy | `auctionit-email-worker` isn't registered in pm2, so `pm2 restart all` never started it | `pm2 list` to confirm, then start it per above and `pm2 save` |

## Common pm2 commands

```bash
pm2 list                          # all processes
pm2 logs                          # tail all
pm2 logs auctionit-api --err      # error stream only
pm2 logs auctionit-api --lines 50
pm2 restart all                   # only restarts what's already listed
pm2 save                          # persist current process list across reboots
pm2 monit                         # live CPU/RAM
```

After adding or removing any process, run `pm2 save` — otherwise it is lost on the next reboot even though `pm2 list` shows it now.

## Browser URLs (testers)

- API health — http://10.10.130.137:4000/health
- Swagger — http://10.10.130.137:4000/docs
