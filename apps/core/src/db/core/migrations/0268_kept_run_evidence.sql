CREATE TABLE `kept_run_evidence` (
	`run_id` text PRIMARY KEY NOT NULL,
	`kept_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workflow_state_run_idx` ON `workflow_state` (`run_id`);