CREATE TABLE `business_store_versions` (
	`store_id` text NOT NULL,
	`version` integer NOT NULL,
	`schema_hash` text NOT NULL,
	`operation_manifest_hash` text NOT NULL,
	`source_tree_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`store_id`, `version`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_store_versions_definition` ON `business_store_versions` (`store_id`,`schema_hash`,`operation_manifest_hash`);--> statement-breakpoint
ALTER TABLE `sdk_resource_bindings` ADD `target_version` integer;