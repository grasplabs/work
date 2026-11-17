CREATE TABLE `brain_sync_disconnects` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`request` text NOT NULL,
	`actor` text NOT NULL,
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
	`key` text NOT NULL,
	`generation` integer NOT NULL,
	`store` text,
	`change` text,
	`readers` text,
	`listing` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `feed`, `item_id`)
);
--> statement-breakpoint
CREATE INDEX `brain_sync_items_store_idx` ON `brain_sync_items` (`connection_id`,`store`);--> statement-breakpoint
CREATE TABLE `brain_sync_sources` (
	`connection_id` text NOT NULL,
	`feed` text NOT NULL,
	`place` text NOT NULL,
	`person_id` text NOT NULL,
	`provider` text NOT NULL,
	`tenant` text,
	`account_email` text,
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
	PRIMARY KEY(`connection_id`, `feed`, `place`)
);
--> statement-breakpoint
CREATE INDEX `brain_sync_sources_due_idx` ON `brain_sync_sources` (`due_at`);