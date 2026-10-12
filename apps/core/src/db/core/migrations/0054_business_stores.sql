CREATE TABLE `business_stores` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`active_schema_version` integer,
	`active_schema_hash` text,
	`active_operation_manifest_hash` text,
	`policy_generation` integer DEFAULT 1 NOT NULL,
	`physical_namespace_role` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
