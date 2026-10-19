ALTER TABLE `run_lineage_attempts` ADD `calls_settled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `shares_fenced_through` integer DEFAULT 0 NOT NULL;