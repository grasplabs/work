CREATE TABLE `app_test_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`app_version` integer NOT NULL,
	`workflow_resource_id` text NOT NULL,
	`version` integer NOT NULL,
	`manifest_hash` text NOT NULL,
	`build_hash` text NOT NULL,
	`principal` text NOT NULL,
	`input` text NOT NULL,
	`params` text NOT NULL,
	`created_at` integer NOT NULL,
	`deadline` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `app_test_runs_deadline` ON `app_test_runs` (`deadline`);