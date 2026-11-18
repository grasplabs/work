CREATE TABLE `source_reader_tokens` (
	`key` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `accounts` ADD `verified_email` text;