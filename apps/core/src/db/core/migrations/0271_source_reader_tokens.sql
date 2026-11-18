CREATE TABLE `sign_in_addresses` (
	`user_id` text NOT NULL,
	`address` text NOT NULL,
	PRIMARY KEY(`user_id`, `address`)
);
--> statement-breakpoint
CREATE TABLE `source_reader_tokens` (
	`key` text PRIMARY KEY NOT NULL,
	`person` text,
	`token` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `source_reader_tokens_person_idx` ON `source_reader_tokens` (`person`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `verified_email` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `verified_email_at` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `verified_tenant` text;