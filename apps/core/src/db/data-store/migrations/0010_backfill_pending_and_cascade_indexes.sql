DROP INDEX `sdk_schema_backfills_pending`;--> statement-breakpoint
CREATE UNIQUE INDEX `sdk_schema_backfills_one_pending` ON `sdk_schema_backfills` (("state" <> 'complete')) WHERE state <> 'complete';--> statement-breakpoint
DROP INDEX `sdk_record_refs_target`;--> statement-breakpoint
CREATE INDEX `sdk_record_refs_target_cascade` ON `sdk_record_refs` (`to_table_id`,`to_record_id`,`cascade`,`table_id`,`record_id`);