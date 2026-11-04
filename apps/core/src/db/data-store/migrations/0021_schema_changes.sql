CREATE TABLE `sdk_schema_changes` (
	`change_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`base_hash` text NOT NULL,
	`base_manifest` text NOT NULL,
	`contract_hash` text NOT NULL,
	`schema_hash` text NOT NULL,
	`commit` integer NOT NULL,
	`plan` text NOT NULL,
	`superseded` text NOT NULL,
	`rewritten` integer NOT NULL,
	`applied_at` integer NOT NULL,
	`undone_at` integer
);
--> statement-breakpoint
CREATE INDEX `sdk_schema_changes_contract` ON `sdk_schema_changes` (`contract_hash`);--> statement-breakpoint
ALTER TABLE `sdk_schema_activations` ADD `answers` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `sdk_store` ADD `history_held` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `sdk_record_changes_held` ON `sdk_record_changes` (`commit`,`table_id`) WHERE source = 'schema_change';