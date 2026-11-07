CREATE TABLE `sdk_migration_rows` (
	`migration_id` text NOT NULL,
	`table_id` text NOT NULL,
	`record_id` text NOT NULL,
	`revision` integer NOT NULL,
	`value_json` text NOT NULL,
	PRIMARY KEY(`migration_id`, `table_id`, `record_id`)
);
--> statement-breakpoint
ALTER TABLE `sdk_store` ADD `schema_catalog` text;--> statement-breakpoint
ALTER TABLE `sdk_store` ADD `schema_version` integer;--> statement-breakpoint
ALTER TABLE `sdk_store` ADD `schema_applied_at` integer;