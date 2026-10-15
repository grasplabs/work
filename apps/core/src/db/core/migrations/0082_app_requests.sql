CREATE TABLE `app_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`why` text,
	`url` text,
	`requested_by` text NOT NULL,
	`requested_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_requests_name_key_idx` ON `app_requests` (`name_key`);--> statement-breakpoint
CREATE INDEX `app_requests_requested_at_idx` ON `app_requests` (`requested_at`);