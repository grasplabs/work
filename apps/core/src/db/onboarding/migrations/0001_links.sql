CREATE TABLE `interviews` (
	`person` text PRIMARY KEY NOT NULL,
	`progress` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `link_codes` (
	`person` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`mark` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `link_codes_mark_unique` ON `link_codes` (`mark`);--> statement-breakpoint
ALTER TABLE `links` ADD `key_mark` text;--> statement-breakpoint
ALTER TABLE `links` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `links` ADD `version` integer DEFAULT 0 NOT NULL;