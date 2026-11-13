-- For databases that applied the earlier master migration with disposition_id PKs.
IF COL_LENGTH('lifting_client_disposition_master', 'disposition_id') IS NOT NULL
BEGIN
  IF EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = 'FK_lifting_engagement_log_disposition'
  )
    ALTER TABLE [lifting_engagement_log] DROP CONSTRAINT [FK_lifting_engagement_log_disposition];

  EXEC sp_rename N'lifting_client_disposition_master.disposition_id', N'id', N'COLUMN';
  EXEC sp_rename N'lifting_bidder_disposition_master.disposition_id', N'id', N'COLUMN';

  ALTER TABLE [lifting_engagement_log] ADD CONSTRAINT [FK_lifting_engagement_log_disposition]
    FOREIGN KEY ([disposition_id]) REFERENCES [lifting_bidder_disposition_master]([id]);
END
