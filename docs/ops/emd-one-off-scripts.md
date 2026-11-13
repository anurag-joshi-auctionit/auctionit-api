# EMD scripts: what to run when

All run as `pnpm <name>`. Dry run is the default wherever a script writes.

## Fresh production load

```
pnpm db:push
pnpm emd:sync-type-constraint   # only if EMD_TYPES changed since the DB was last pushed
./src/db/seed/seed.sh           # runs seed:emd, emd:verify-seed, emd:verify-holds
```

No repair script is needed: `seed:emd` builds one hold per won EMD range. If `emd:verify-holds` reports a finding, the output names the script to use.

## Database seeded before the holds model (test DB)

In this order:

```
pnpm emd:backfill-range-holds        # builds holds from old blocked_winning rows
pnpm emd:split-null-range-holds      # --apply to write; splits range-less holds per range
pnpm emd:credit-released-holds       # list, then --apply --hold <id> one at a time
pnpm emd:rebuild-balances
pnpm emd:verify-holds
```

## Scripts

| Script | Fixes | Applies to | Safe to re-run | Retire when |
|---|---|---|---|---|
| `seed:emd` | loads ledger, refunds, forfeitures and holds from MSSQL | fresh load (truncates EMD tables) | yes, full reload | never |
| `emd:verify-seed` | compares seeded EMD with MSSQL | after `seed:emd` | read-only | never |
| `emd:verify-holds` | finds holds that need a repair script | any DB | read-only | never |
| `emd:rebuild-balances` | rebuilds bidder balance caches from the ledger | any DB | yes | never |
| `emd:sync-type-constraint` | rebuilds the `emd_type` check constraint (`db:push` cannot) | after `EMD_TYPES` changes | yes | never |
| `emd:backfill-range-holds` | creates holds from legacy `blocked_winning` rows | DB seeded before the holds model | skips existing holds | after prod go-live |
| `emd:split-null-range-holds` | splits a range-less hold into one hold per range; skips holds with releases or forfeitures | DB with range-less holds | yes (`--apply` to write) | after prod go-live |
| `emd:credit-released-holds` | credits a hold whose lots are all released but still holds money | one hold at a time, after review | yes (`--apply --hold <id>`) | after prod go-live |
| `emd:recompute-with-client-holds` | reallocates a hold whose `lot_ids` include a with-client lot (never actually blocked) back across the bidder's ranges | any DB with such a hold | yes (`--apply` to write) | once no DB has any such hold |
| `emd:drop-outbid-type` | removes the unused `release_winning_outbid` enum value | DB that still has it | yes | after prod go-live |

## Before running `emd:credit-released-holds`

Do not credit a hold that `emd:verify-holds` also lists under "stale lot release after reopen". That money was re-blocked by a second close under the old Winning model and no admin has released it; the lots are hidden by old release records (one release row per bidder and lot is allowed). Today's close does not re-hold a range that was already released, so this comes from legacy data only. Decide per case; do not credit it automatically.

## Retiring the one-offs

After production go-live and a clean `emd:verify-holds`, delete the four "after prod go-live" scripts and their `package.json` entries in one commit.
