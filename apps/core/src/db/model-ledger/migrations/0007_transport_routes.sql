CREATE TABLE `transport_health` (
	`transport` text PRIMARY KEY NOT NULL,
	`last_ok_at` integer,
	`last_failed_at` integer,
	`last_failure` text,
	`last_status` integer
);
--> statement-breakpoint
ALTER TABLE `requests` ADD `transport` text;--> statement-breakpoint
ALTER TABLE `requests` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `requests` ADD `region` text;