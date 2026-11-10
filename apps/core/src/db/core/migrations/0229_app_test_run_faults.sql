ALTER TABLE `app_test_runs` ADD `restart_after_step` text;--> statement-breakpoint
ALTER TABLE `app_test_runs` ADD `restarted_at` integer;--> statement-breakpoint
ALTER TABLE `app_test_runs` ADD `model_requests` text DEFAULT '{}' NOT NULL;