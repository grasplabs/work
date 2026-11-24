CREATE TABLE `workflow_run_controls` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`generation` integer NOT NULL,
	`requested_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	`retry_at` integer NOT NULL,
	`retries` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_run_controls_unresolved_idx` ON `workflow_run_controls` (`run_id`,`kind`) WHERE state = 'admitted';--> statement-breakpoint
CREATE INDEX `workflow_run_controls_admitted_idx` ON `workflow_run_controls` (`retry_at`,`id`) WHERE state = 'admitted';--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `control_generation` integer DEFAULT 0 NOT NULL;