-- Workflows keep no stores (GRA-1552): their versions' bindings of one go,
-- and only Apps own a store from here on.
DELETE FROM `sdk_resource_bindings` WHERE `kind` = 'store' AND `resource_id` IN (SELECT `id` FROM `workflow_resources`);--> statement-breakpoint
DROP TABLE `workflow_stores`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sdk_store_owners` (
	`store_id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`claimed_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_sdk_store_owners`("store_id", "app_id", "claimed_at") SELECT "store_id", "app_id", "claimed_at" FROM `sdk_store_owners` WHERE "app_id" IS NOT NULL;--> statement-breakpoint
DROP TABLE `sdk_store_owners`;--> statement-breakpoint
ALTER TABLE `__new_sdk_store_owners` RENAME TO `sdk_store_owners`;--> statement-breakpoint
PRAGMA foreign_keys=ON;