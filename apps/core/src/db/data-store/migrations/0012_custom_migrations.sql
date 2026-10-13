CREATE TABLE `sdk_migration_work` (
	`target_hash` text NOT NULL,
	`table_id` text NOT NULL,
	`record_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`queued_at` integer NOT NULL,
	PRIMARY KEY(`target_hash`, `table_id`, `record_id`)
);
--> statement-breakpoint
CREATE INDEX `sdk_migration_work_batches` ON `sdk_migration_work` (`target_hash`,`table_id`,`owner_id`,`record_id`);--> statement-breakpoint
ALTER TABLE `sdk_schema_backfills` ADD `cursor_owner` text;--> statement-breakpoint
ALTER TABLE `sdk_schema_backfills` ADD `cursor_created_at` integer;--> statement-breakpoint
ALTER TABLE `sdk_schema_backfills` ADD `migrations` text;--> statement-breakpoint
ALTER TABLE `sdk_schema_backfills` ADD `phase` text DEFAULT 'scan' NOT NULL;--> statement-breakpoint
ALTER TABLE `sdk_schemas` ADD `superseded_at` integer;