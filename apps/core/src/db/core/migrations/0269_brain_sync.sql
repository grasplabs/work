CREATE TABLE `brain_sync_catch_ups` (
	`connection_id` text NOT NULL,
	`feed` text NOT NULL,
	`place` text NOT NULL,
	`item_id` text NOT NULL,
	PRIMARY KEY(`connection_id`, `feed`, `place`, `item_id`)
);
--> statement-breakpoint
CREATE TABLE `brain_sync_disconnects` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`request` text NOT NULL,
	`actor` text,
	`requested_at` integer NOT NULL,
	`erasing` integer NOT NULL,
	`erased` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `brain_sync_disconnects_erasing_idx` ON `brain_sync_disconnects` (`erasing`);--> statement-breakpoint
CREATE TABLE `brain_sync_items` (
	`connection_id` text NOT NULL,
	`feed` text NOT NULL,
	`item_id` text NOT NULL,
	`place` text NOT NULL,
	`key` text NOT NULL,
	`generation` integer NOT NULL,
	`store` text,
	`change` text,
	`version` integer,
	`marker` text,
	`part_of` text,
	`listing` integer NOT NULL,
	`leaving` text,
	`leaving_store` text,
	`held_since` integer,
	PRIMARY KEY(`connection_id`, `feed`, `item_id`)
);
--> statement-breakpoint
CREATE INDEX `brain_sync_items_store_idx` ON `brain_sync_items` (`connection_id`,`store`);--> statement-breakpoint
CREATE INDEX `brain_sync_items_leaving_idx` ON `brain_sync_items` (`connection_id`,`feed`,`leaving`);--> statement-breakpoint
CREATE INDEX `brain_sync_items_place_idx` ON `brain_sync_items` (`connection_id`,`feed`,`place`);--> statement-breakpoint
CREATE INDEX `brain_sync_items_part_of_idx` ON `brain_sync_items` (`connection_id`,`feed`,`part_of`);--> statement-breakpoint
CREATE TABLE `brain_sync_sources` (
	`connection_id` text NOT NULL,
	`feed` text NOT NULL,
	`place` text NOT NULL,
	`person_id` text NOT NULL,
	`provider` text NOT NULL,
	`tenant` text,
	`account` text,
	`cursor` text,
	`listing` integer NOT NULL,
	`listing_open` integer NOT NULL,
	`due_at` integer NOT NULL,
	`lease_id` text,
	`lease_until` integer,
	`last_success_at` integer,
	`last_error` text,
	`added` integer NOT NULL,
	`changed` integer NOT NULL,
	`removed` integer NOT NULL,
	`relist_cursor` text,
	`relisting` integer NOT NULL,
	`relist_at` integer NOT NULL,
	`relist_since` integer,
	`leaves_owed` integer NOT NULL,
	`kind` text NOT NULL,
	`dropped` integer NOT NULL,
	`relist_catch_up` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `feed`, `place`)
);
--> statement-breakpoint
CREATE INDEX `brain_sync_sources_due_idx` ON `brain_sync_sources` (`due_at`);--> statement-breakpoint
CREATE TABLE `source_reader_tokens` (
	`key` text PRIMARY KEY NOT NULL,
	`person` text,
	`token` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `source_reader_tokens_person_idx` ON `source_reader_tokens` (`person`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `verified_email` text;