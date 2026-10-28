ALTER TABLE `app_test_runs` ADD `models` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_test_runs` ADD `operations` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_test_runs` ADD `store_id` text;