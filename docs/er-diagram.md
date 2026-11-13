# AuctionIT ER Diagram

Entity-relationship diagrams for the **auctionit-new** Postgres schema.

**Source of truth:** [`src/db/schema/`](../src/db/schema/) (Drizzle table definitions and `.references()` FKs).  
[`relations.ts`](../src/db/schema/relations.ts) is incomplete for tooling — column FKs are authoritative.

## Legend

| Marker             | Meaning                                                      |
| ------------------ | ------------------------------------------------------------ |
| `PK`               | Primary key                                                  |
| `FK`               | Foreign key enforced in Postgres                             |
| `UK`               | Unique constraint / unique index                             |
| Solid relationship | Declared `.references()` FK                                  |
| Label `"soft ref"` | Logical link (int column, no FK) — often legacy sentinel `0` |
| Label `"logical"`  | App-level mapping without a DB FK                            |

**Column convention:** Entity boxes include identity/business keys and relationship-relevant fields. Routine audit columns (`created_by`, `updated_by`, `created_at`, `updated_at`, and similar) are omitted unless they are the only FK to another table.

**Cardinality:**

- `\|\|--o{` — one to many
- `\|\|--o\|` — one to zero-or-one
- `}\|--\|{` — many to many (via join table)

---

## Overview (relationships only)

```mermaid
erDiagram
  roles ||--o{ users : has
  roles ||--o{ role_permissions : grants
  permissions ||--o{ role_permissions : granted_by
  users ||--o{ user_clients : assigned
  clients ||--o{ user_clients : assigned
  users |o--o| bidders : "soft ref bidder_id"

  locations ||--o{ clients : located_in
  locations ||--o{ plant_locations : located_in
  locations ||--o{ material_locations : located_in
  locations ||--o{ bidders : located_in
  clients ||--o{ plant_locations : has
  clients ||--o{ material_locations : has
  clients ||--o{ items : owns
  clients ||--o{ auctions : runs
  clients ||--o{ client_document_logs : has
  clients ||--o{ bidder_block_logs : blocks
  clients ||--o{ service_invoices : billed
  plant_locations ||--o{ service_invoices : billed_at

  materials ||--o{ materials : parent_of
  materials ||--o{ items : categorizes
  uoms ||--o{ items : measures
  uoms ||--o{ auction_lots : measures
  client_document_types ||--o{ client_document_logs : typed_as

  bidders ||--o{ bidder_registrations : from
  bidders ||--o| bidder_bank_accounts : has
  bidders ||--o{ bidder_document_logs : has
  bidders ||--o{ bidder_block_logs : blocked
  bidders ||--o{ bidder_exemption_logs : exemptions
  bidder_document_types ||--o{ bidder_document_logs : typed_as
  bidders ||--o{ subscriptions : pays
  bidders ||--o{ subscription_payment_requests : requests
  subscription_types ||--o{ subscriptions : plan
  subscription_types ||--o{ subscription_payment_requests : plan
  payment_types ||--o{ subscriptions : mode
  subscriptions |o--o{ subscription_payment_requests : fulfills

  clients ||--o{ auction_lots : owns
  auctions ||--o{ auction_lots : contains
  auctions ||--o{ auction_lot_items : contains
  auctions ||--o{ auction_lot_bidder_maps : maps
  auctions ||--o{ auction_lot_emd_ranges : emd_bands
  auctions ||--o{ auction_documents : has
  auctions ||--o{ auction_bids : receives
  auctions ||--o{ auction_proxy_bids : receives
  auctions ||--o{ auction_lot_extensions : extends
  auctions ||--o{ auction_tnc_acceptances : accepted
  auctions ||--o{ lifting_client_logs : lifting
  auction_lots ||--o{ auction_lot_items : contains
  auction_lots ||--o{ auction_bids : receives
  auction_lots ||--o{ auction_proxy_bids : receives
  auction_lots ||--o{ auction_lot_watchlist : watched
  auction_lots ||--o{ auction_lot_extensions : extended
  auction_lots ||--o{ lifting_client_logs : lifting
  auction_lots ||--o{ lifting_engagement_logs : engagement
  plant_locations ||--o{ auction_lots : plant
  material_locations ||--o{ auction_lots : material_site
  items ||--o{ auction_lot_items : listed
  items ||--o{ lifting_client_logs : lifted
  bidders ||--o{ auction_lot_bidder_maps : invited
  bidders ||--o{ auction_bids : places
  bidders ||--o{ auction_proxy_bids : places
  bidders ||--o{ auction_lot_watchlist : watches
  bidders ||--o{ auction_tnc_acceptances : accepts
  auction_document_types ||--o{ auction_documents : typed_as
  benchmark_material_locations ||--o{ auction_lot_items : priced_vs
  benchmark_material_locations ||--o{ benchmark_prices : has

  bidders ||--o{ emd_passbook : "soft ref"
  bidders ||--o{ emd_reserved : "soft ref"
  bidders ||--o{ emd_transactions : "soft ref"
  bidders ||--o{ emd_refund_requests : "soft ref"
  auctions ||--o{ emd_passbook : "soft ref"
  auctions ||--o{ emd_reserved : "soft ref"
  auctions ||--o{ emd_transactions : "soft ref"
  auctions ||--o{ emd_refund_requests : "soft ref"
  emd_passbook ||--o{ emd_refund_requests : "soft ref passbook_trn_id"

  lifting_client_dispositions ||--o{ lifting_client_logs : "logical lifting_status"
  lifting_bidder_dispositions ||--o{ lifting_engagement_logs : disposition

  service_invoice_document_types ||--o{ service_invoice_documents : typed_as
  service_invoices ||--o{ service_invoice_documents : has
  service_invoices ||--o{ service_invoice_payment_logs : payments

  files }o--|| users : uploaded_by
  sms_templates
```

---

## 1. Identity & RBAC

```mermaid
erDiagram
  roles {
    int id PK
    varchar code UK
    varchar name
    boolean is_admin
  }

  permissions {
    int id PK
    varchar key UK
    varchar label
    varchar group
  }

  role_permissions {
    int role_id PK "FK"
    int permission_id PK "FK"
    boolean enabled
  }

  users {
    int id PK
    varchar user_login_name
    varchar name
    varchar email_id
    int role_id FK
    boolean is_owner
    int bidder_id UK "soft ref"
    boolean is_active
  }

  user_clients {
    int user_id PK "FK"
    int client_id PK "FK"
    boolean is_active
  }

  clients {
    int id PK
    varchar company_name
  }

  bidders {
    int id PK
    varchar company_name
  }

  roles ||--o{ users : role
  roles ||--o{ role_permissions : grants
  permissions ||--o{ role_permissions : granted_by
  users ||--o{ user_clients : assigned
  clients ||--o{ user_clients : assigned
  users |o--o| bidders : "soft ref bidder_id"
```

Notes:

- `roles.created_by` / `updated_by` are plain ints (no FK) to avoid a circular import with `users.role_id → roles`.
- `users.bidder_id` is unique (strict 1:1 login ↔ bidder) but has **no FK**.

---

## 2. Geography & clients

```mermaid
erDiagram
  locations {
    int id PK
    varchar country
    varchar state
    varchar city
  }

  clients {
    int id PK
    varchar company_name
    varchar address
    int location_id FK
    varchar pincode
    varchar pan
    varchar tan
    varchar gstin
    int_array materials "material ids"
    boolean is_active
    varchar auction_prefix
    service_fee_type service_fee_type
    real service_fee_value
    boolean auto_extend
    boolean is_staggered
    smallint stagger_interval
  }

  plant_locations {
    int id PK
    int client_id FK
    varchar name
    int location_id FK
    varchar pincode
    boolean is_active
    int kam_id FK
    varchar gstin
    varchar pan
    int grace_period
  }

  material_locations {
    int id PK
    int client_id FK
    varchar name
    int location_id FK
    varchar pincode
    boolean is_active
  }

  client_document_types {
    int id PK
    varchar name
    varchar file_name_prefix
    boolean is_active
  }

  client_document_logs {
    int id PK
    int client_id FK
    int document_type_id FK
    varchar file_name
    varchar s3_key
    boolean is_active
  }

  locations ||--o{ clients : located_in
  locations ||--o{ plant_locations : located_in
  locations ||--o{ material_locations : located_in
  clients ||--o{ plant_locations : has
  clients ||--o{ material_locations : has
  clients ||--o{ client_document_logs : has
  client_document_types ||--o{ client_document_logs : typed_as
```

Notes:

- Unique index on `locations (country, state, city)`.
- `clients.materials` is an `int[]` of materials-master ids (no FK array).

---

## 3. Catalog masters

```mermaid
erDiagram
  materials {
    int id PK
    text label
    boolean is_active
    int parent_id FK
    int depth
  }

  uoms {
    smallint id PK
    varchar code UK
    boolean is_active
  }

  items {
    int id PK
    int client_id FK
    varchar name
    boolean is_active
    int material_id FK
    smallint uom_id FK
  }

  clients {
    int id PK
    varchar company_name
  }

  files {
    int id PK
    varchar filename
    varchar s3_key UK
    int uploaded_by FK
  }

  users {
    int id PK
    varchar user_login_name
  }

  sms_templates {
    int id PK
    varchar code UK
    varchar template_id UK
    varchar purpose
    varchar message_format
  }

  payment_types {
    int id PK
    varchar name
    boolean is_active
  }

  subscription_types {
    int id PK
    varchar name
    numeric amount
    numeric gst_percent
    int months
    boolean is_active
  }

  materials ||--o{ materials : parent_of
  materials ||--o{ items : categorizes
  uoms ||--o{ items : measures
  clients ||--o{ items : owns
  users ||--o{ files : uploaded_by
```

---

## 4. Bidders

```mermaid
erDiagram
  locations {
    int id PK
    varchar city
  }

  bidders {
    int id PK
    varchar company_name
    int location_id FK
    varchar pincode
    varchar pan
    varchar gstin
    int_array materials
    boolean is_active
    boolean is_verified
    boolean is_exempted
    double emd_balance
  }

  bidder_registrations {
    int id PK
    varchar company_name
    int bidder_id FK
    int admin_status
    int subscription_type_id "no FK"
    int payment_mode "no FK"
    varchar payment_status
    int payment_updated_by FK
  }

  bidder_bank_accounts {
    int id PK
    int bidder_id FK "UK"
    varchar bank_account
    varchar bank_name
    varchar bank_ifsc
    boolean is_verified
    int verified_by FK
  }

  bidder_block_logs {
    int id PK
    int client_id FK
    int bidder_id FK
    boolean is_blocked
    varchar reason
  }

  bidder_exemption_logs {
    int id PK
    int bidder_id FK
    boolean is_exempted
    varchar reason
  }

  bidder_document_types {
    int id PK
    varchar name
    varchar file_name_prefix
    boolean is_active
  }

  bidder_document_logs {
    int id PK
    int bidder_id FK
    int document_type_id FK
    varchar file_name
    varchar s3_key
    boolean is_active
  }

  clients {
    int id PK
    varchar company_name
  }

  locations ||--o{ bidders : located_in
  bidders ||--o{ bidder_registrations : from
  bidders ||--o| bidder_bank_accounts : has
  bidders ||--o{ bidder_document_logs : has
  bidders ||--o{ bidder_block_logs : blocked
  bidders ||--o{ bidder_exemption_logs : exemptions
  clients ||--o{ bidder_block_logs : blocks
  bidder_document_types ||--o{ bidder_document_logs : typed_as
```

Notes:

- `bidder_bank_accounts.bidder_id` unique → effective **1:1**.
- `bidder_registrations` keeps legacy country/state/city ids and some subscription/payment ints **without FKs**.

---

## 5. Auctions & bidding

```mermaid
erDiagram
  clients {
    int id PK
    varchar company_name
  }

  auctions {
    int auction_id PK
    int client_id FK
    varchar auction_number
    auction_type auction_type
    numeric consolidated_emd_amount
    timestamp auction_date
    auction_status status
    boolean is_active
    boolean is_staggered
    boolean is_sealed_bid
    boolean is_rank_based
  }

  auction_lots {
    int id PK
    int client_id FK
    int auction_id FK
    varchar lot_number
    numeric quantity
    numeric start_bid_price
    smallint uom_id FK
    int plant_location_id FK
    int material_location_id FK
    boolean is_approved
    int winner_user_id "soft ref"
    int winner_bidder_id "soft ref"
    numeric winning_amount
    timestamp extended_end_time
    int bid_count
    int bidder_count
    boolean is_active
  }

  auction_lot_items {
    int id PK
    int client_id FK
    int auction_id FK
    int lot_id FK
    int item_id FK
    numeric quantity
    int benchmark_material_location_id FK
    varchar material_name
    boolean is_active
  }

  auction_lot_bidder_maps {
    int id PK
    int auction_id FK
    int client_id FK
    int bidder_id FK
    int lot_id "soft ref"
    boolean is_emd_with_client
    boolean is_active
  }

  auction_lot_emd_ranges {
    int id PK
    int auction_id FK
    numeric lot_display_order_from
    numeric lot_display_order_to
    numeric emd_amount
    int display_order
  }

  auction_bids {
    int id PK
    int auction_id FK
    int lot_id FK
    int bidder_id FK
    int user_id FK
    numeric amount
    boolean is_proxy
    numeric proxy_amount
  }

  auction_proxy_bids {
    int id PK
    int auction_id FK
    int lot_id FK
    int bidder_id FK
    int user_id FK
    numeric max_amount
    boolean is_active
  }

  auction_lot_watchlist {
    int id PK
    int bidder_id FK
    int lot_id FK
  }

  auction_lot_extensions {
    int id PK
    int auction_id FK
    int lot_id FK
    timestamp old_ends_at
    timestamp new_ends_at
    int extended_by_sec
    int triggered_by_bidder_id "soft ref"
    lot_extension_reason reason
  }

  auction_tnc_acceptances {
    int id PK
    int auction_id FK
    int bidder_id FK
    timestamp accepted_at
    int accepted_by_user_id FK
  }

  auction_document_types {
    int id PK
    varchar name
    varchar file_name_prefix
    boolean is_active
  }

  auction_documents {
    int id PK
    int auction_id FK
    int document_type_id FK
    varchar file_name
    varchar s3_key UK
    boolean is_active
  }

  bidders {
    int id PK
    varchar company_name
  }

  uoms {
    smallint id PK
    varchar code
  }

  items {
    int id PK
    varchar name
  }

  plant_locations {
    int id PK
    varchar name
  }

  material_locations {
    int id PK
    varchar name
  }

  benchmark_material_locations {
    int id PK
    varchar material
    varchar location
  }

  clients ||--o{ auctions : runs
  clients ||--o{ auction_lots : owns
  auctions ||--o{ auction_lots : contains
  auctions ||--o{ auction_lot_items : contains
  auctions ||--o{ auction_lot_bidder_maps : maps
  auctions ||--o{ auction_lot_emd_ranges : emd_bands
  auctions ||--o{ auction_documents : has
  auctions ||--o{ auction_bids : receives
  auctions ||--o{ auction_proxy_bids : receives
  auctions ||--o{ auction_lot_extensions : extends
  auctions ||--o{ auction_tnc_acceptances : accepted
  auction_lots ||--o{ auction_lot_items : contains
  auction_lots ||--o{ auction_bids : receives
  auction_lots ||--o{ auction_proxy_bids : receives
  auction_lots ||--o{ auction_lot_watchlist : watched
  auction_lots ||--o{ auction_lot_extensions : extended
  uoms ||--o{ auction_lots : measures
  plant_locations ||--o{ auction_lots : plant
  material_locations ||--o{ auction_lots : material_site
  items ||--o{ auction_lot_items : listed
  benchmark_material_locations ||--o{ auction_lot_items : priced_vs
  bidders ||--o{ auction_lot_bidder_maps : invited
  bidders ||--o{ auction_bids : places
  bidders ||--o{ auction_proxy_bids : places
  bidders ||--o{ auction_lot_watchlist : watches
  bidders ||--o{ auction_tnc_acceptances : accepts
  auction_document_types ||--o{ auction_documents : typed_as
```

Notes:

- PK column on `auctions` is `auction_id` (mapped as `id` in Drizzle).
- Soft refs (no FK): `auction_lots.winner_user_id`, `winner_bidder_id`; `auction_lot_bidder_maps.lot_id`; `auction_lot_extensions.triggered_by_bidder_id`.
- Unique: `(auction_id, document_type_id)` on documents; `(bidder_id, lot_id)` on watchlist; `(auction_id, bidder_id)` on T&C.

---

## 6. EMD finance (soft refs)

Legacy MSSQL data uses sentinel `0` for “not applicable”, so these tables store plain ints/bigints **without foreign keys**.

```mermaid
erDiagram
  emd_passbook {
    bigint trn_id PK
    bigint bidder_comp_id "soft ref bidders"
    bigint auction_id "soft ref auctions"
    bigint lot_emd_id "soft ref"
    numeric amount_cr
    numeric amount_dr
    emd_transaction_type transaction_type
    bigint reverses_trn_id "self soft ref"
    int created_by "soft ref users"
  }

  emd_reserved {
    int id PK
    int auction_id "soft ref auctions"
    int bidder_id "soft ref bidders"
    boolean is_emd_with_client
    numeric amount
    varchar block_status
    smallint emd_status
    numeric emd_balance "generated"
    boolean is_refund
  }

  emd_transactions {
    int id PK
    bigint bidder_id "soft ref bidders"
    bigint auction_id "soft ref auctions"
    int client_id "soft ref clients"
    numeric amount
    smallint payment_status
    smallint admin_status
    smallint account_status
  }

  emd_refund_requests {
    bigint pay_id PK
    bigint bidder_comp_id "soft ref bidders"
    int client_id "soft ref clients"
    bigint auction_id "soft ref auctions"
    numeric amount
    emd_refund_status status
    bigint passbook_trn_id "soft ref emd_passbook"
    boolean is_request_from_admin
  }

  bidders {
    int id PK
    varchar company_name
  }

  auctions {
    int auction_id PK
  }

  clients {
    int id PK
  }

  bidders ||--o{ emd_passbook : "soft ref"
  bidders ||--o{ emd_reserved : "soft ref"
  bidders ||--o{ emd_transactions : "soft ref"
  bidders ||--o{ emd_refund_requests : "soft ref"
  auctions ||--o{ emd_passbook : "soft ref"
  auctions ||--o{ emd_reserved : "soft ref"
  auctions ||--o{ emd_transactions : "soft ref"
  auctions ||--o{ emd_refund_requests : "soft ref"
  clients ||--o{ emd_transactions : "soft ref"
  clients ||--o{ emd_refund_requests : "soft ref"
  emd_passbook ||--o{ emd_refund_requests : "soft ref passbook_trn_id"
```

---

## 7. Subscriptions

```mermaid
erDiagram
  bidders {
    int id PK
    varchar company_name
  }

  subscription_types {
    int id PK
    varchar name
    numeric amount
    numeric gst_percent
    int months
  }

  payment_types {
    int id PK
    varchar name
  }

  subscriptions {
    int id PK
    int bidder_id FK
    int subscription_type_id FK
    date from_date
    date to_date
    numeric subscription_price
    numeric gst_amount
    numeric amount
    int payment_mode FK
    varchar transaction_id
    date payment_date
  }

  subscription_payment_requests {
    int id PK
    int bidder_id FK
    int subscription_type_id FK
    varchar merchant_txn_id UK
    numeric amount
    varchar status
    int subscription_id FK
  }

  bidders ||--o{ subscriptions : pays
  bidders ||--o{ subscription_payment_requests : requests
  subscription_types ||--o{ subscriptions : plan
  subscription_types ||--o{ subscription_payment_requests : plan
  payment_types ||--o{ subscriptions : mode
  subscriptions |o--o{ subscription_payment_requests : fulfills
```

Notes:

- Subscription status is **derived** (`to_date >= today`), not stored.
- Payment request `status`: `requested` | `completed` | `failed` (varchar, not a Postgres enum).

---

## 8. Benchmarks

```mermaid
erDiagram
  benchmark_material_locations {
    int id PK
    varchar material
    varchar location
    boolean is_active
  }

  benchmark_prices {
    int id PK
    int benchmark_material_location_id FK
    date benchmark_date
    numeric price
  }

  auction_lot_items {
    int id PK
    int benchmark_material_location_id FK
  }

  benchmark_material_locations ||--o{ benchmark_prices : has
  benchmark_material_locations ||--o{ auction_lot_items : priced_vs
```

Notes:

- Unique `(material, location)` on combo master; unique `(combo_id, benchmark_date)` on prices.
- Combos are free-text material/location strings, **not** FKs to `materials` / `locations`.

---

## 9. Lifting / CRM

```mermaid
erDiagram
  lifting_client_dispositions {
    int id PK
    varchar key UK
    varchar label
    boolean is_active
    int sort_order
  }

  lifting_bidder_dispositions {
    int id PK
    varchar key UK
    varchar label
    boolean requires_lifted_qty
    boolean requires_next_followup
    boolean is_active
  }

  lifting_client_logs {
    bigint id PK
    timestamp lifting_entry_date
    date lifting_date
    int client_id FK
    int auction_id FK
    int lot_id FK
    int item_id FK
    numeric qty
    int lifting_status "logical FK"
  }

  lifting_engagement_logs {
    bigint id PK
    int client_id FK
    int lot_id FK
    int disposition_id FK
    text notes
    timestamptz next_followup
    numeric lifted_qty_bidder
    int logged_by_user_id FK
  }

  clients {
    int id PK
  }

  auctions {
    int auction_id PK
  }

  auction_lots {
    int id PK
  }

  items {
    int id PK
  }

  clients ||--o{ lifting_client_logs : has
  auctions ||--o{ lifting_client_logs : has
  auction_lots ||--o{ lifting_client_logs : has
  items ||--o{ lifting_client_logs : has
  clients ||--o{ lifting_engagement_logs : has
  auction_lots ||--o{ lifting_engagement_logs : has
  lifting_bidder_dispositions ||--o{ lifting_engagement_logs : disposition
  lifting_client_dispositions ||--o{ lifting_client_logs : "logical lifting_status"
```

Notes:

- Fixed ids **1–5** on `lifting_client_dispositions` map to `lifting_client_logs.lifting_status` (no FK).
- `auction_lots.latest_lifted_*` is denormalized from the newest client lifting log row.

---

## 10. Service invoicing

```mermaid
erDiagram
  clients {
    int id PK
    varchar company_name
  }

  plant_locations {
    int id PK
    varchar name
  }

  service_invoices {
    int id PK
    int client_id FK
    int plant_location_id FK
    timestamp from_date
    timestamp to_date
    service_invoice_type type
    numeric total_quantity
    numeric total_amount
    service_fee_type service_fee_type
    numeric service_fee_value
    numeric service_fee_amount
    numeric grand_total
    varchar invoice_number
    service_invoice_payment_status payment_status
    service_invoice_status status
  }

  service_invoice_document_types {
    int id PK
    varchar name
    varchar file_name_prefix
    boolean is_active
  }

  service_invoice_documents {
    int id PK
    int service_invoice_id FK
    int document_type_id FK
    varchar file_name
    varchar s3_key
    boolean is_active
  }

  service_invoice_payment_logs {
    int id PK
    int service_invoice_id FK
    numeric paid_amount
    timestamp paid_at
    boolean is_active
  }

  clients ||--o{ service_invoices : billed
  plant_locations ||--o{ service_invoices : billed_at
  service_invoices ||--o{ service_invoice_documents : has
  service_invoices ||--o{ service_invoice_payment_logs : payments
  service_invoice_document_types ||--o{ service_invoice_documents : typed_as
```

Notes:

- Unique `(service_invoice_id, document_type_id)`.
- Parent `paid_amount` / `unpaid_amount` / `payment_status` are derived from active payment log rows.

---

## Appendix A: Postgres enums

| Enum                             | Values                                                                                                                          | Defined in                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `service_fee_type`               | `service_percentage`, `fixed_amount`, `pmt`                                                                                     | `clients.ts` (from `@auctionit/messages`) |
| `auction_type`                   | `forward`, `reverse`, `yankee`                                                                                                  | `auctions.ts`                             |
| `auction_status`                 | `draft`, `archived`, `published`, `closed`                                                                                      | `auctions.ts`                             |
| `emd_transaction_type`           | `emd_credit`, `auction_block`, `lot_block`, `auction_release`, `lot_release`, `user_refund`, `admin_correction`, `admin_cancel` | `emd-passbook.ts`                         |
| `emd_refund_status`              | `pending`, `approved`, `rejected`, `refunded`                                                                                   | `emd-refund-requests.ts`                  |
| `lot_extension_reason`           | `bid`, `auto_increment`, `stagger`                                                                                              | `auction-lot-extensions.ts`               |
| `service_invoice_type`           | `auto`, `manual`                                                                                                                | `service-invoices.ts`                     |
| `service_invoice_status`         | `draft`, `requested`, `generated`, `recheck`, `cancelled`                                                                       | `service-invoices.ts`                     |
| `service_invoice_payment_status` | `unpaid`, `partially_paid`, `paid`                                                                                              | `service-invoices.ts`                     |

**Not Postgres enums** (app constants / varchar / smallint codes): `ROLE_CODES`, `SMS_TEMPLATE_CODES`, `AUCTION_SCHEDULE_BUCKETS`, subscription payment request status, many legacy smallint status fields on EMD / registrations.

---

## Appendix B: Soft / logical relationships

| From                      | Column(s)                                                                     | To                                      | Notes                                    |
| ------------------------- | ----------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------- |
| `users`                   | `bidder_id`                                                                   | `bidders.id`                            | Unique 1:1; no FK                        |
| `auction_lots`            | `winner_user_id`                                                              | `users.id`                              | No FK                                    |
| `auction_lots`            | `winner_bidder_id`                                                            | `bidders.id`                            | No FK                                    |
| `auction_lot_bidder_maps` | `lot_id`                                                                      | `auction_lots.id`                       | No FK                                    |
| `auction_lot_extensions`  | `triggered_by_bidder_id`                                                      | `bidders.id`                            | No FK; null for auto-increment / stagger |
| `lifting_client_logs`     | `lifting_status`                                                              | `lifting_client_dispositions.id`        | Logical map (ids 1–5)                    |
| `emd_passbook`            | `bidder_comp_id`, `auction_id`, `lot_emd_id`, `created_by`, `reverses_trn_id` | bidders / auctions / self / users       | Sentinel `0`; no FKs                     |
| `emd_reserved`            | `auction_id`, `bidder_id`                                                     | auctions / bidders                      | No FKs                                   |
| `emd_transactions`        | `bidder_id`, `auction_id`, `client_id`                                        | bidders / auctions / clients            | No FKs                                   |
| `emd_refund_requests`     | `bidder_comp_id`, `client_id`, `auction_id`, `passbook_trn_id`                | bidders / clients / auctions / passbook | No FKs                                   |
| `clients` / `bidders`     | `materials`                                                                   | `materials.id`                          | `int[]`; no array FK                     |
| `bidder_registrations`    | `subscription_type_id`, `payment_mode`, legacy location ids                   | various                                 | Legacy ints; mostly no FKs               |
| `roles`                   | `created_by`, `updated_by`                                                    | `users.id`                              | Plain ints (circular-import avoidance)   |
