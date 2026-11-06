ALTER TABLE `sdk_schema_activations` ADD `field_ids` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `sdk_schemas` ADD `field_ids` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `sdk_store` ADD `contract_ids` text DEFAULT '{}' NOT NULL;