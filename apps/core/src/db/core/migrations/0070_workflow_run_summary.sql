ALTER TABLE `workflow_runs` ADD `engine_status` text;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `started_at` integer;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `summary_revision` integer DEFAULT 0 NOT NULL;