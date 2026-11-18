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
ALTER TABLE `accounts` ADD `verified_tenant` text;--> statement-breakpoint
-- No sign-in account is made for a person whose erasure began, or changed
-- (source-readers.ts `erasureBegan`): Better Auth writes `accounts` itself,
-- so the condition sits on the table and holds in each of its statements.
CREATE TRIGGER `accounts_insert_not_erased` BEFORE INSERT ON `accounts`
WHEN EXISTS (SELECT 1 FROM `person_erasures` WHERE `person_erasures`.`user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'The person is being erased.');
END;--> statement-breakpoint
CREATE TRIGGER `accounts_update_not_erased` BEFORE UPDATE ON `accounts`
WHEN EXISTS (SELECT 1 FROM `person_erasures` WHERE `person_erasures`.`user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'The person is being erased.');
END;
