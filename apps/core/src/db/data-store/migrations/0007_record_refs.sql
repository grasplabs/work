CREATE TABLE `sdk_record_refs` (
	`table_id` text NOT NULL,
	`record_id` text NOT NULL,
	`to_table_id` text NOT NULL,
	`to_record_id` text NOT NULL,
	PRIMARY KEY(`table_id`, `record_id`, `to_table_id`, `to_record_id`)
);
--> statement-breakpoint
CREATE INDEX `sdk_record_refs_target` ON `sdk_record_refs` (`to_table_id`,`to_record_id`);