ALTER TABLE `app_test_runs` ADD `fixture_store_id` text;--> statement-breakpoint
ALTER TABLE `app_test_runs` ADD `approvals` text DEFAULT '{}' NOT NULL;