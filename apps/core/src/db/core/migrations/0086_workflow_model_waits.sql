CREATE TABLE `workflow_model_waits` (
	`run_id` text NOT NULL,
	`step_hash` text NOT NULL,
	`owner` text NOT NULL,
	`waiting_for` text,
	`retry_at` integer NOT NULL,
	`seen_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `step_hash`)
);
--> statement-breakpoint
CREATE INDEX `workflow_model_waits_seen_idx` ON `workflow_model_waits` (`seen_at`);