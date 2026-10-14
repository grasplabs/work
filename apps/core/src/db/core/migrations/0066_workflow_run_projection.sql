ALTER TABLE `workflow_runs` ADD `engine_sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `pending_start` text;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `cancel_requested_at` integer;--> statement-breakpoint
CREATE INDEX `workflow_runs_pending_start_idx` ON `workflow_runs` (`id`) WHERE pending_start IS NOT NULL;