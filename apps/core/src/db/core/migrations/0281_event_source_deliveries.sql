CREATE TABLE `event_source_counts` (
	`source_id` text NOT NULL,
	`outcome` text NOT NULL,
	`hour` integer NOT NULL,
	`count` integer NOT NULL,
	`last_at` integer NOT NULL,
	PRIMARY KEY(`source_id`, `outcome`, `hour`)
);
--> statement-breakpoint
CREATE INDEX `event_source_counts_hour` ON `event_source_counts` (`hour`);--> statement-breakpoint
CREATE TABLE `event_source_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`event_type` text NOT NULL,
	`test` integer NOT NULL,
	`triggers` integer NOT NULL,
	`payload` text
);
--> statement-breakpoint
CREATE INDEX `event_source_deliveries_source` ON `event_source_deliveries` (`source_id`,`received_at`,`id`);--> statement-breakpoint
CREATE INDEX `event_source_deliveries_received` ON `event_source_deliveries` (`received_at`);