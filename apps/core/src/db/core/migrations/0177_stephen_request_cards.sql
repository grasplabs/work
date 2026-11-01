CREATE TABLE `stephen_request_cards` (
	`key` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `stephen_summaries` ADD `claimed_until` integer;