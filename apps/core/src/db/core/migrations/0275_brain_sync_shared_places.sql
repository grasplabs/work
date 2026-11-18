PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_brain_sync_sources` (
	`connection_id` text NOT NULL,
	`feed` text NOT NULL,
	`place` text NOT NULL,
	`person_id` text,
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
	`seen_in` integer,
	PRIMARY KEY(`connection_id`, `feed`, `place`)
);
--> statement-breakpoint
INSERT INTO `__new_brain_sync_sources`("connection_id", "feed", "place", "person_id", "provider", "tenant", "account", "cursor", "listing", "listing_open", "due_at", "lease_id", "lease_until", "last_success_at", "last_error", "added", "changed", "removed", "relist_cursor", "relisting", "relist_at", "relist_since", "leaves_owed", "kind", "dropped", "relist_catch_up", "seen_in") SELECT "connection_id", "feed", "place", "person_id", "provider", "tenant", "account", "cursor", "listing", "listing_open", "due_at", "lease_id", "lease_until", "last_success_at", "last_error", "added", "changed", "removed", "relist_cursor", "relisting", "relist_at", "relist_since", "leaves_owed", "kind", "dropped", "relist_catch_up", "seen_in" FROM `brain_sync_sources`;--> statement-breakpoint
DROP TABLE `brain_sync_sources`;--> statement-breakpoint
ALTER TABLE `__new_brain_sync_sources` RENAME TO `brain_sync_sources`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `brain_sync_sources_due_idx` ON `brain_sync_sources` (`due_at`);--> statement-breakpoint
CREATE INDEX `brain_sync_sources_person_idx` ON `brain_sync_sources` (`person_id`,`dropped`);