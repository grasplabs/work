CREATE TABLE `app_integrations` (
	`app_id` text NOT NULL,
	`source` text NOT NULL,
	`connector_id` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `source`, `connector_id`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `apps` ADD `responsible_id` text;--> statement-breakpoint
ALTER TABLE `apps` ADD `audience_type` text;--> statement-breakpoint
ALTER TABLE `apps` ADD `audience_id` text;