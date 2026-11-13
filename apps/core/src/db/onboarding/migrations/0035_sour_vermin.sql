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
	`erase` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `brain_interviews_person` ON `brain_interviews` (`person`);--> statement-breakpoint
CREATE TABLE `link_addresses` (
	`person` text NOT NULL,
	`address` text NOT NULL,
	`first` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`person`, `address`)
);
--> statement-breakpoint
CREATE INDEX `link_addresses_address` ON `link_addresses` (`address`);--> statement-breakpoint
ALTER TABLE `links` ADD `account` text;--> statement-breakpoint
ALTER TABLE `links` ADD `brain_mark` text;--> statement-breakpoint
CREATE UNIQUE INDEX `links_account_unique` ON `links` (`account`);