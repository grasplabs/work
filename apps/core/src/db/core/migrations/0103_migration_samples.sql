CREATE TABLE `migration_samples` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`version` integer NOT NULL,
	`migration` text NOT NULL,
	`store_id` text NOT NULL,
	`outcome` text NOT NULL,
	`rows` integer NOT NULL,
	`owners` integer NOT NULL,
	`reason` text,
	`manifest_hash` text NOT NULL,
	`from_schema` text NOT NULL,
	`to_schema` text NOT NULL,
	`sampled_by` text NOT NULL,
	`sampled_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `migration_samples_latest_idx` ON `migration_samples` (`app_id`,`version`,`migration`,`sampled_at`);