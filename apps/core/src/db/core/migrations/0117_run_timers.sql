ALTER TABLE `workflow_resource_runs` ADD `timer` text;--> statement-breakpoint
ALTER TABLE `workflow_resource_runs` ADD `timer_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_resource_runs` ADD `timers_passed` integer DEFAULT 0 NOT NULL;