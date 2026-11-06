CREATE TABLE `workflow_state` (
	`workflow_resource_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`run_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workflow_resource_id`, `key`),
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workflow_state_snapshots` (
	`hash` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_state_writes` (
	`step_key` text PRIMARY KEY NOT NULL,
	`workflow_resource_id` text NOT NULL,
	`run_id` text NOT NULL,
	`write_id` text NOT NULL,
	`bytes` integer NOT NULL,
	`written_at` integer NOT NULL,
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_state_writes_workflow_idx` ON `workflow_state_writes` (`workflow_resource_id`);--> statement-breakpoint
ALTER TABLE `workflow_candidate_runs` ADD `state_hash` text;--> statement-breakpoint
CREATE INDEX `workflow_candidate_runs_state_idx` ON `workflow_candidate_runs` (`state_hash`);--> statement-breakpoint
ALTER TABLE `workflow_start_receipts` ADD `state_hash` text;--> statement-breakpoint
CREATE INDEX `workflow_start_receipts_state_idx` ON `workflow_start_receipts` (`state_hash`) WHERE "workflow_start_receipts"."state_hash" IS NOT NULL;