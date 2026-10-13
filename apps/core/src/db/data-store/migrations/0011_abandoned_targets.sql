CREATE TABLE `sdk_abandoned_targets` (
	`target_hash` text NOT NULL,
	`base_hash` text,
	`attempt` integer NOT NULL,
	`scanned` integer NOT NULL,
	`filled` integer NOT NULL,
	`failure` text NOT NULL,
	`schemas` text NOT NULL,
	`consumers` text NOT NULL,
	`reserved` text NOT NULL,
	`abandoned_by` text NOT NULL,
	`abandoned_at` integer NOT NULL,
	`audited_at` integer,
	PRIMARY KEY(`target_hash`, `attempt`)
);
--> statement-breakpoint
CREATE TABLE `sdk_reserved_fields` (
	`table_name` text NOT NULL,
	`field_name` text NOT NULL,
	`descriptor` text NOT NULL,
	`target_hash` text NOT NULL,
	`reserved_at` integer NOT NULL,
	PRIMARY KEY(`table_name`, `field_name`)
);
--> statement-breakpoint
ALTER TABLE `sdk_schema_activations` ADD `abandoned_at` integer;--> statement-breakpoint
ALTER TABLE `sdk_schemas` ADD `abandoned_at` integer;