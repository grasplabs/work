CREATE TABLE `sdk_import_rows` (
	`import_id` text NOT NULL,
	`position` integer NOT NULL,
	`principal` text NOT NULL,
	`table_name` text NOT NULL,
	`record_id` text NOT NULL,
	`value_json` text NOT NULL,
	`staged_at` integer NOT NULL,
	PRIMARY KEY(`import_id`, `position`)
);
--> statement-breakpoint
CREATE INDEX `sdk_import_rows_staged_at` ON `sdk_import_rows` (`staged_at`);--> statement-breakpoint
CREATE TABLE `sdk_record_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`changed_at` integer NOT NULL,
	`commit` integer,
	`table_id` text NOT NULL,
	`table_name` text NOT NULL,
	`record_id` text NOT NULL,
	`op` text NOT NULL,
	`source` text NOT NULL,
	`actor` text NOT NULL,
	`principal` text NOT NULL,
	`bytes` integer NOT NULL,
	`fields` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`values_left_out` text
);
--> statement-breakpoint
CREATE INDEX `sdk_record_changes_record` ON `sdk_record_changes` (`table_id`,`record_id`,`id`);--> statement-breakpoint
CREATE INDEX `sdk_record_changes_changed_at` ON `sdk_record_changes` (`changed_at`);--> statement-breakpoint
ALTER TABLE `sdk_cascade_jobs` ADD `actor` text DEFAULT '{"type":"system"}' NOT NULL;--> statement-breakpoint
ALTER TABLE `sdk_store` ADD `history_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sdk_tables` ADD `sensitive` integer DEFAULT false NOT NULL;