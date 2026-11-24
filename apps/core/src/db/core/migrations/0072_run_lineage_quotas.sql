CREATE TABLE `quota_policies` (
	`generation` integer PRIMARY KEY NOT NULL,
	`limits` text NOT NULL,
	`limits_hash` text NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_lineage_attempts` (
	`run_id` text NOT NULL,
	`step_key` text NOT NULL,
	`attempt` integer NOT NULL,
	`generation` integer NOT NULL,
	`root_run_id` text NOT NULL,
	`reserved_ms` integer NOT NULL,
	`deadline` integer NOT NULL,
	`used_ms` integer,
	`admitted_at` integer NOT NULL,
	`settled_at` integer,
	`policy_generation` integer NOT NULL,
	PRIMARY KEY(`run_id`, `step_key`, `attempt`, `generation`),
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`root_run_id`) REFERENCES `run_lineages`(`root_run_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `run_lineage_attempts_held_idx` ON `run_lineage_attempts` (`root_run_id`,`admitted_at`) WHERE settled_at IS NULL;--> statement-breakpoint
CREATE TABLE `run_lineages` (
	`root_run_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`descendants` integer DEFAULT 0 NOT NULL,
	`active_used_ms` integer DEFAULT 0 NOT NULL,
	`active_held_ms` integer DEFAULT 0 NOT NULL,
	`policy_generation` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`root_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `depth` integer DEFAULT 0 NOT NULL;