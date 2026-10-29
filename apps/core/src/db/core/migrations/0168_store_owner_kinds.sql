PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sdk_store_owners` (
	`store_id` text PRIMARY KEY NOT NULL,
	`app_id` text,
	`workflow_id` text,
	`claimed_at` integer NOT NULL,
	CONSTRAINT "sdk_store_owners_one_owner" CHECK((app_id IS NULL) <> (workflow_id IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_sdk_store_owners`("store_id", "app_id", "workflow_id", "claimed_at") SELECT "store_id", "app_id", NULL, "claimed_at" FROM `sdk_store_owners`;--> statement-breakpoint
DROP TABLE `sdk_store_owners`;--> statement-breakpoint
ALTER TABLE `__new_sdk_store_owners` RENAME TO `sdk_store_owners`;--> statement-breakpoint
PRAGMA foreign_keys=ON;