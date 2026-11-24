CREATE TABLE `app_default_stores` (
	`app_id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_default_stores_store_id_unique` ON `app_default_stores` (`store_id`);