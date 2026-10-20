-- A wake for an independent workflow's run too (workflows/wakes.ts,
-- GRA-688): `run_id` (an App's run) becomes optional, and
-- `resource_run_id` names a row of `workflow_resource_runs`, exactly one
-- of the two per wake. SQLite changes a column's key only by making its
-- table again; no table refers to this one. D1 and Durable Objects ignore
-- `PRAGMA foreign_keys = OFF`, so the copied rows' keys are checked at the
-- commit instead (as 0093 does).
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__new_workflow_run_wakes` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`resource_run_id` text,
	`type` text NOT NULL,
	`created_at` integer NOT NULL,
	`retry_at` integer NOT NULL,
	`retries` integer DEFAULT 0 NOT NULL,
	`resend_until` integer,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resource_run_id`) REFERENCES `workflow_resource_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workflow_run_wakes_one_run" CHECK((run_id IS NULL) <> (resource_run_id IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_workflow_run_wakes`("id", "run_id", "resource_run_id", "type", "created_at", "retry_at", "retries", "resend_until") SELECT "id", "run_id", NULL, "type", "created_at", "retry_at", "retries", "resend_until" FROM `workflow_run_wakes`;--> statement-breakpoint
DROP TABLE `workflow_run_wakes`;--> statement-breakpoint
ALTER TABLE `__new_workflow_run_wakes` RENAME TO `workflow_run_wakes`;--> statement-breakpoint
CREATE INDEX `workflow_run_wakes_due_idx` ON `workflow_run_wakes` (`retry_at`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_run_wakes_resend_idx` ON `workflow_run_wakes` (`resend_until`) WHERE resend_until IS NOT NULL;