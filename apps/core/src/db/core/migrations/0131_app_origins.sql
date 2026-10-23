CREATE TABLE `app_origins` (
	`app_id` text PRIMARY KEY NOT NULL,
	`blueprint_id` text NOT NULL,
	`blueprint_version` integer,
	`tree` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `app_versions` ADD `code` text;--> statement-breakpoint
ALTER TABLE `blueprints` ADD `attested_code` text;--> statement-breakpoint
ALTER TABLE `blueprints` ADD `attested_release` text;