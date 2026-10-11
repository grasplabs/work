CREATE TABLE `sdk_records` (
	`table_id` text NOT NULL,
	`record_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`value_json` text NOT NULL,
	`schema_hash` text NOT NULL,
	PRIMARY KEY(`table_id`, `record_id`),
	FOREIGN KEY (`table_id`) REFERENCES `sdk_tables`(`table_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sdk_records_revision" CHECK("sdk_records"."revision" >= 1),
	CONSTRAINT "sdk_records_value" CHECK(json_valid("sdk_records"."value_json") AND json_type("sdk_records"."value_json") = 'object'),
	CONSTRAINT "sdk_records_updated" CHECK("sdk_records"."updated_at" >= "sdk_records"."created_at")
);
--> statement-breakpoint
CREATE TABLE `sdk_store` (
	`only` integer PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "sdk_store_only" CHECK("sdk_store"."only" = 1)
);
--> statement-breakpoint
CREATE TABLE `sdk_tables` (
	`table_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "sdk_tables_name_key_lower" CHECK("sdk_tables"."name_key" = lower("sdk_tables"."name"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sdk_tables_name_key` ON `sdk_tables` (`name_key`);