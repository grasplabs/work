CREATE TABLE `sdk_schema_change_values` (
	`change_id` integer NOT NULL,
	`table_id` text NOT NULL,
	`record_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`revision` integer NOT NULL,
	`value_json` text,
	`schema_hash` text NOT NULL,
	PRIMARY KEY(`change_id`, `table_id`, `record_id`)
);
--> statement-breakpoint
CREATE INDEX `sdk_schema_change_values_record` ON `sdk_schema_change_values` (`table_id`,`record_id`);--> statement-breakpoint
CREATE INDEX `sdk_schema_change_values_owner` ON `sdk_schema_change_values` (`owner_id`);--> statement-breakpoint
CREATE TABLE `sdk_schema_changes` (
	`change_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`base_hash` text NOT NULL,
	`base_manifest` text NOT NULL,
	`contract_hash` text NOT NULL,
	`schema_hash` text NOT NULL,
	`plan` text NOT NULL,
	`superseded` text NOT NULL,
	`rewritten` integer NOT NULL,
	`applied_at` integer NOT NULL,
	`undone_at` integer
);
--> statement-breakpoint
CREATE INDEX `sdk_schema_changes_contract` ON `sdk_schema_changes` (`contract_hash`);--> statement-breakpoint
ALTER TABLE `sdk_schema_activations` ADD `answers` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE TRIGGER `sdk_schema_change_values_gone` AFTER DELETE ON `sdk_records` BEGIN
	DELETE FROM `sdk_schema_change_values` WHERE `table_id` = old.`table_id` AND `record_id` = old.`record_id`;
END;
