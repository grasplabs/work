CREATE TABLE `trigger_hour_slots` (
	`trigger_id` text NOT NULL,
	`event_key` text NOT NULL,
	`taken_at` integer NOT NULL,
	PRIMARY KEY(`trigger_id`, `event_key`),
	FOREIGN KEY (`trigger_id`) REFERENCES `trigger_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `trigger_hour_slots_taken` ON `trigger_hour_slots` (`trigger_id`,`taken_at`);--> statement-breakpoint
CREATE INDEX `trigger_hour_slots_taken_at` ON `trigger_hour_slots` (`taken_at`);--> statement-breakpoint
ALTER TABLE `trigger_resources` ADD `email_address` text;--> statement-breakpoint
CREATE UNIQUE INDEX `trigger_resources_email_address_unique` ON `trigger_resources` (`email_address`);