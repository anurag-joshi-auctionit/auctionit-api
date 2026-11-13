-- Baseline tables are already present in MSSQL (introspected via pull-mssql.mjs).
-- This migration only applies the additions from prior PG migrations 2/3/4:
--   add_password_algo_and_indexes, add_lifting_engagement_log, add_approval_date_to_auctionlot.

ALTER TABLE [tbl_Config_User]
  ADD [password_algo] varchar(16) NOT NULL CONSTRAINT [DF_tbl_Config_User_password_algo] DEFAULT ('md5'),
      [session_expires_at] datetime2;
--> statement-breakpoint
ALTER TABLE [tbl_Data_Auction]
  ADD [default_bid_increment] decimal(18, 2);
--> statement-breakpoint
ALTER TABLE [tbl_Data_AuctionLot]
  ADD [latest_lifted_status] int NOT NULL CONSTRAINT [DF_tbl_Data_AuctionLot_latest_lifted_status] DEFAULT (1),
      [latest_lifted_date] date,
      [latest_lifted_qty] decimal(18, 3) NOT NULL CONSTRAINT [DF_tbl_Data_AuctionLot_latest_lifted_qty] DEFAULT (0),
      [approval_date] date;
--> statement-breakpoint
CREATE TABLE [lifting_engagement_log] (
	[id] bigint IDENTITY(1, 1),
	[client_id] int NOT NULL,
	[lot_id] int NOT NULL,
	[disposition_status] varchar(64) NOT NULL,
	[notes] nvarchar(max) NOT NULL,
	[next_followup] datetime2 NOT NULL,
	[lifted_qty_bidder] decimal(18,3),
	[logged_by_user_id] int NOT NULL,
	[created_at] datetime2 NOT NULL,
	CONSTRAINT [lifting_engagement_log_pkey] PRIMARY KEY([id])
);
--> statement-breakpoint
CREATE INDEX [idx_tbl_data_auction_biddercomp_map_auction_id] ON [tbl_Data_Auction_BidderComp_Map] ([AuctionId]);
--> statement-breakpoint
CREATE INDEX [idx_tbl_data_auctionlot_auction_id] ON [tbl_Data_AuctionLot] ([AuctionId]);
--> statement-breakpoint
CREATE INDEX [lifting_engagement_log_lot_created_idx] ON [lifting_engagement_log] ([client_id],[lot_id],[created_at]);
