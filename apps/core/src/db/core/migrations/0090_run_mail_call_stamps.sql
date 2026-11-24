CREATE TABLE `run_mail_stamp_claims` (
	`stamp` text NOT NULL,
	`source` text NOT NULL,
	`event_key` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`stamp`, `source`, `event_key`)
);
--> statement-breakpoint
CREATE TABLE `run_mail_stamp_refusals` (
	`trigger_key` text PRIMARY KEY NOT NULL,
	`stamp` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `run_mail_stamp_refusals_stamp_idx` ON `run_mail_stamp_refusals` (`stamp`);--> statement-breakpoint
ALTER TABLE `run_mail_calls` ADD `stamp` text;--> statement-breakpoint
ALTER TABLE `run_mail_calls` ADD `recipients` text;--> statement-breakpoint
ALTER TABLE `run_mail_calls` ADD `senders` text;--> statement-breakpoint
CREATE UNIQUE INDEX `run_mail_calls_stamp_idx` ON `run_mail_calls` (`stamp`);