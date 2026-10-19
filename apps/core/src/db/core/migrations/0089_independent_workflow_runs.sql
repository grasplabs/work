CREATE TABLE `workflow_resource_run_terminations` (
	`run_id` text PRIMARY KEY NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_resource_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_resource_run_terminations_next_idx` ON `workflow_resource_run_terminations` (`next_at`);--> statement-breakpoint
CREATE TABLE `workflow_resource_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_resource_id` text NOT NULL,
	`version` integer NOT NULL,
	`manifest_hash` text NOT NULL,
	`build_hash` text NOT NULL,
	`principal_id` text NOT NULL,
	`status` text NOT NULL,
	`engine_sequence` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	`start_attempts` integer DEFAULT 0 NOT NULL,
	`next_start_at` integer,
	`failure_code` text,
	FOREIGN KEY (`id`) REFERENCES `workflow_start_receipts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_resource_runs_workflow_idx` ON `workflow_resource_runs` (`workflow_resource_id`,`status`);--> statement-breakpoint
CREATE INDEX `workflow_resource_runs_starting_idx` ON `workflow_resource_runs` (`created_at`) WHERE "workflow_resource_runs"."status" = 'starting';--> statement-breakpoint
-- A run of an independent workflow pins what it runs and for whom when its
-- start's receipt admits it (workflows/resource-runs.ts): its version,
-- manifest, build and principal never change, an ended run never changes
-- again, and no run is removed. Only a run that hasn't ended moves on:
-- its status, the notification it last took, when and why it ended, and
-- the repair's count of the starts it sent.
CREATE TRIGGER `workflow_resource_runs_pinned` BEFORE UPDATE ON `workflow_resource_runs`
WHEN OLD.`status` IN ('completed', 'failed', 'cancelled') OR NOT (
	NEW.`id` IS OLD.`id`
	AND NEW.`workflow_resource_id` IS OLD.`workflow_resource_id`
	AND NEW.`version` IS OLD.`version`
	AND NEW.`manifest_hash` IS OLD.`manifest_hash`
	AND NEW.`build_hash` IS OLD.`build_hash`
	AND NEW.`principal_id` IS OLD.`principal_id`
	AND NEW.`created_at` IS OLD.`created_at`
) BEGIN
	SELECT RAISE(ABORT, 'workflow_resource_runs pin what they run, and an ended run stays ended');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_runs_kept` BEFORE DELETE ON `workflow_resource_runs` BEGIN
	SELECT RAISE(ABORT, 'workflow_resource_runs are kept');
END;
