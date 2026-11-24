-- A decision for an independent workflow's run too (src/decisions/,
-- GRA-941): `run_id` (an App's run) becomes optional, and
-- `resource_run_id` names a row of `workflow_resource_runs`, exactly one
-- of the two per decision; `input` keeps what an independent run's
-- decision is about, and `response` what an answer's payload must be.
-- SQLite changes a column's key only by making its
-- table again. D1 and Durable Objects ignore `PRAGMA foreign_keys = OFF`,
-- so the copied rows' keys are checked at the commit instead (as 0105
-- does). Dropping the old table deletes its one-use confirmations
-- (`workflow_decision_confirmations` cascades): each lives five minutes,
-- and a person whose confirmation went confirms their answer again.
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__new_workflow_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`resource_run_id` text,
	`step` text NOT NULL,
	`deciders` text NOT NULL,
	`starter_excluded` integer DEFAULT false NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`opened_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`payload` text,
	`input` text,
	`response` text,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resource_run_id`) REFERENCES `workflow_resource_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workflow_decisions_one_run" CHECK((run_id IS NULL) <> (resource_run_id IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_workflow_decisions`("id", "run_id", "resource_run_id", "step", "deciders", "starter_excluded", "description", "status", "opened_at", "expires_at", "decided_by", "decided_at", "payload", "input", "response") SELECT "id", "run_id", NULL, "step", "deciders", "starter_excluded", "description", "status", "opened_at", "expires_at", "decided_by", "decided_at", "payload", NULL, NULL FROM `workflow_decisions`;--> statement-breakpoint
DROP TABLE `workflow_decisions`;--> statement-breakpoint
ALTER TABLE `__new_workflow_decisions` RENAME TO `workflow_decisions`;--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_decisions_run_step_idx` ON `workflow_decisions` (`run_id`,`step`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_decisions_resource_run_step_idx` ON `workflow_decisions` (`resource_run_id`,`step`);--> statement-breakpoint
CREATE INDEX `workflow_decisions_run_status_idx` ON `workflow_decisions` (`run_id`,`status`);--> statement-breakpoint
CREATE INDEX `workflow_decisions_status_opened_idx` ON `workflow_decisions` (`status`,`opened_at`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_decisions_decided_idx` ON `workflow_decisions` (`decided_at`,`id`);