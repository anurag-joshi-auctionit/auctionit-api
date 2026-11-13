CREATE TABLE [lifting_client_disposition_master] (
	[id] int NOT NULL,
	[key] varchar(64) NOT NULL,
	[label] nvarchar(128) NOT NULL,
	[description] nvarchar(500) NOT NULL CONSTRAINT [DF_lifting_client_disposition_master_description] DEFAULT (''),
	[is_active] bit NOT NULL CONSTRAINT [DF_lifting_client_disposition_master_is_active] DEFAULT (1),
	[sort_order] int NOT NULL CONSTRAINT [DF_lifting_client_disposition_master_sort_order] DEFAULT (0),
	CONSTRAINT [lifting_client_disposition_master_pkey] PRIMARY KEY([id]),
	CONSTRAINT [lifting_client_disposition_master_key_unique] UNIQUE([key])
);
--> statement-breakpoint
CREATE TABLE [lifting_bidder_disposition_master] (
	[id] int IDENTITY(1, 1),
	[key] varchar(64) NOT NULL,
	[label] nvarchar(128) NOT NULL,
	[description] nvarchar(500) NOT NULL CONSTRAINT [DF_lifting_bidder_disposition_master_description] DEFAULT (''),
	[is_active] bit NOT NULL CONSTRAINT [DF_lifting_bidder_disposition_master_is_active] DEFAULT (1),
	[requires_lifted_qty] bit NOT NULL CONSTRAINT [DF_lifting_bidder_disposition_master_requires_lifted_qty] DEFAULT (0),
	[sort_order] int NOT NULL CONSTRAINT [DF_lifting_bidder_disposition_master_sort_order] DEFAULT (0),
	CONSTRAINT [lifting_bidder_disposition_master_pkey] PRIMARY KEY([id]),
	CONSTRAINT [lifting_bidder_disposition_master_key_unique] UNIQUE([key])
);
--> statement-breakpoint
MERGE [lifting_client_disposition_master] AS target
USING (VALUES
	(1, 'OPEN', N'Open', N'', 1, 1),
	(2, 'SHORT_CLOSED', N'Short Closed', N'', 1, 2),
	(3, 'CLOSED', N'Closed', N'', 1, 3),
	(4, 'EMD_FORFEIT', N'EMD Forfeit', N'', 1, 4),
	(5, 'LOT_CANCELLED', N'Lot Cancelled', N'', 1, 5)
) AS source (id, [key], label, description, is_active, sort_order)
ON target.id = source.id
WHEN NOT MATCHED THEN
	INSERT (id, [key], label, description, is_active, sort_order)
	VALUES (source.id, source.[key], source.label, source.description, source.is_active, source.sort_order);
--> statement-breakpoint
MERGE [lifting_bidder_disposition_master] AS target
USING (VALUES
	('VEHICLE_PLACED', N'Vehicle Placed', N'', 1, 0, 1),
	('MATERIAL_SITE_NOT_READY', N'Material / Site Not Ready', N'', 1, 0, 2),
	('LIFTING_ONGOING', N'Lifting Ongoing', N'', 1, 1, 3),
	('PARTIAL_LIFTING_DONE', N'Partial Lifting Done', N'', 1, 1, 4),
	('LIFTING_COMPLETED', N'Lifting Completed', N'', 1, 1, 5),
	('EXTENSION_REQUESTED', N'Extension Requested', N'', 1, 0, 6),
	('ISSUE_COMPLAINT_RAISED', N'Issue / Complaint Raised', N'', 1, 0, 7),
	('LOT_CANCELLED_BY_CLIENT', N'Lot Cancelled by Client', N'', 1, 0, 8),
	('SO_PENDING', N'SO Pending', N'', 1, 0, 9),
	('EMD_FORFEITURE', N'EMD Forfeiture', N'', 1, 0, 10),
	('NOT_RESPONDING', N'Not Responding', N'', 1, 0, 11),
	('WRONG_NUMBER', N'Wrong Number', N'', 1, 0, 12),
	('FOLLOW_UP_SCHEDULED', N'Follow-up Scheduled', N'', 1, 0, 13)
) AS source ([key], label, description, is_active, requires_lifted_qty, sort_order)
ON target.[key] = source.[key]
WHEN NOT MATCHED THEN
	INSERT ([key], label, description, is_active, requires_lifted_qty, sort_order)
	VALUES (source.[key], source.label, source.description, source.is_active, source.requires_lifted_qty, source.sort_order);
--> statement-breakpoint
ALTER TABLE [lifting_engagement_log] ADD [disposition_id] int;
--> statement-breakpoint
UPDATE e
SET disposition_id = m.id
FROM [lifting_engagement_log] e
INNER JOIN [lifting_bidder_disposition_master] m ON m.[key] = e.disposition_status;
--> statement-breakpoint
UPDATE e
SET disposition_id = (SELECT TOP 1 id FROM [lifting_bidder_disposition_master] WHERE [key] = 'FOLLOW_UP_SCHEDULED')
FROM [lifting_engagement_log] e
WHERE e.disposition_id IS NULL;
--> statement-breakpoint
ALTER TABLE [lifting_engagement_log] ALTER COLUMN [disposition_id] int NOT NULL;
--> statement-breakpoint
ALTER TABLE [lifting_engagement_log] ADD CONSTRAINT [FK_lifting_engagement_log_disposition] FOREIGN KEY ([disposition_id]) REFERENCES [lifting_bidder_disposition_master]([id]);
--> statement-breakpoint
ALTER TABLE [lifting_engagement_log] DROP COLUMN [disposition_status];
