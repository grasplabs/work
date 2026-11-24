CREATE TABLE `sdk_rules_owed` (
	`owed_id` text PRIMARY KEY NOT NULL,
	`resource_kind` text NOT NULL,
	`resource_id` text NOT NULL,
	`resource_version` integer NOT NULL,
	`schema_hash` text NOT NULL,
	`owed_at` integer NOT NULL,
	`due_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sdk_rules_owed_due` ON `sdk_rules_owed` (`due_at`);