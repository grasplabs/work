CREATE TABLE `sdk_schema_activations` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`resource_id` text NOT NULL,
	`resource_version` integer NOT NULL,
	`schema_hash` text NOT NULL,
	`base_hash` text,
	`contract_hash` text NOT NULL,
	`plan_hash` text NOT NULL,
	`plan` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `sdk_store` ADD `contract_hash` text;--> statement-breakpoint
ALTER TABLE `sdk_store` ADD `contract_manifest` text;