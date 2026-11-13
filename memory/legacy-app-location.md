---
name: legacy-app-location
description: Where the old ASP.NET AuctionIT app and its SQL live, for porting pages to the new app
metadata:
  type: reference
---

Pages are being ported from the legacy ASP.NET MVC app to the new app (apps/admin + apps/api). Legacy sources:

- App code: `/Users/apple/work/AuctionIT5.0/AuctionIt5.0/` — Controllers (`Controllers/*.cs`), Views (`Views/<Area>/*.cshtml`), repositories (`Models/Repository/*.cs`). Data access is Dapper calling stored procs.
- Stored-proc + schema dump: `/Users/apple/work/auction-it/migration/Auction_IT_Live.sql` (~195k lines, UTF-16 — chars appear space-separated when grepped). Proc bodies define the real query logic (e.g. `proc_EMDReport`, `proc_GetPassbook`).

Porting pattern: read the controller action → repository method → the stored proc in the SQL dump to recover the exact computation, then re-derive it against the new Postgres schema (`apps/api/src/db/schema/`). Legacy MSSQL table → new table mapping is documented in `apps/api/src/db/seed/seed-commands.txt`.
