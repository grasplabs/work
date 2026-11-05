CREATE TABLE `workflow_state_snapshots` (
	`hash` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `workflow_candidate_runs` ADD `state_hash` text;--> statement-breakpoint
CREATE INDEX `workflow_candidate_runs_state_idx` ON `workflow_candidate_runs` (`state_hash`);--> statement-breakpoint
ALTER TABLE `workflow_start_receipts` ADD `state_hash` text;--> statement-breakpoint
CREATE INDEX `workflow_start_receipts_state_idx` ON `workflow_start_receipts` (`state_hash`) WHERE "workflow_start_receipts"."state_hash" IS NOT NULL;