CREATE TABLE `brain_claims` (
	`source` text PRIMARY KEY NOT NULL,
	`record` text NOT NULL,
	`team` text NOT NULL,
	`text` text NOT NULL,
	`erase` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `brain_claims_record` ON `brain_claims` (`record`);--> statement-breakpoint
CREATE TABLE `brain_interviews` (
	`source` text PRIMARY KEY NOT NULL,
	`person` text NOT NULL,
	`account` text NOT NULL,
	`mark` text NOT NULL,
	`erase` integer DEFAULT false NOT NULL,
	`added` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `brain_interviews_person` ON `brain_interviews` (`person`);--> statement-breakpoint
ALTER TABLE `links` ADD `account` text;--> statement-breakpoint
ALTER TABLE `links` ADD `sent_to` text;--> statement-breakpoint
ALTER TABLE `links` ADD `brain_mark` text;--> statement-breakpoint
CREATE UNIQUE INDEX `links_account_unique` ON `links` (`account`);