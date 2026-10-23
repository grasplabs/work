CREATE TABLE `app_test_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`task` text NOT NULL,
	`step` text NOT NULL,
	`recipient` text NOT NULL,
	`description` text NOT NULL,
	`input` text NOT NULL,
	`response` text NOT NULL,
	`status` text NOT NULL,
	`opened_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`payload` text,
	FOREIGN KEY (`run_id`) REFERENCES `app_test_runs`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_test_decisions_run_step_idx` ON `app_test_decisions` (`run_id`,`step`);--> statement-breakpoint
CREATE INDEX `app_test_decisions_run_task_idx` ON `app_test_decisions` (`run_id`,`task`,`status`);--> statement-breakpoint
ALTER TABLE `app_test_runs` ADD `deciders` text DEFAULT '{}' NOT NULL;