CREATE TABLE `app_test_fixtures` (
	`store_id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `app_test_fixtures_created_at` ON `app_test_fixtures` (`created_at`);