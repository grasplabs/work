CREATE TABLE `sdk_schemas` (
	`schema_hash` text PRIMARY KEY NOT NULL,
	`manifest` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sdk_records_created` ON `sdk_records` (`table_id`,`created_at`,`record_id`);--> statement-breakpoint
CREATE INDEX `sdk_records_owner_created` ON `sdk_records` (`table_id`,`owner_id`,`created_at`,`record_id`);