CREATE TABLE `workflow_run_wakes` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`type` text NOT NULL,
	`created_at` integer NOT NULL,
	`retry_at` integer NOT NULL,
	`retries` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_run_wakes_due_idx` ON `workflow_run_wakes` (`retry_at`,`id`);