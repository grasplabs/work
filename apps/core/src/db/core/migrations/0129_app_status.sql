ALTER TABLE `apps` ADD `status` text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE `apps` ADD `status_changed_at` integer;--> statement-breakpoint
ALTER TABLE `apps` ADD `status_changed_by` text;--> statement-breakpoint
ALTER TABLE `workflow_resource_runs` ADD `stop_requested_at` integer;