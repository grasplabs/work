-- Run lineages for independent workflows' runs too (workflows/quotas.ts):
-- a lineage's root, and an attempt's run, is a row of `workflow_runs` (an
-- App's run) or of `workflow_resource_runs` (an independent workflow's).
-- No foreign key names two tables, so the one to `workflow_runs` goes and
-- a trigger of each table refuses a run neither has, as the key did.
--
-- SQLite drops a foreign key only by making its table again. D1 and
-- Durable Objects ignore `PRAGMA foreign_keys = OFF`, so the checks are
-- deferred to the commit instead, and `run_lineages`, which
-- `run_lineage_attempts` and `run_lineage_children` refer to, is made
-- again under its own name: dropping it counts the rows that refer to it
-- as violations, and each lineage inserted again settles those of its
-- rows. Renaming a new table to `run_lineages`, as drizzle-kit generates,
-- would settle none, and the commit would fail (as workspace 0007).
-- No table refers to `run_lineage_attempts`, so drizzle-kit's rename
-- does for it.
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__old_run_lineages` AS SELECT * FROM `run_lineages`;--> statement-breakpoint
DROP TABLE `run_lineages`;--> statement-breakpoint
CREATE TABLE `run_lineages` (
	`root_run_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`descendants` integer DEFAULT 0 NOT NULL,
	`active_used_ms` integer DEFAULT 0 NOT NULL,
	`active_held_ms` integer DEFAULT 0 NOT NULL,
	`policy_generation` integer DEFAULT 0 NOT NULL,
	`host_calls` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `run_lineages`("root_run_id", "created_at", "descendants", "active_used_ms", "active_held_ms", "policy_generation", "host_calls") SELECT "root_run_id", "created_at", "descendants", "active_used_ms", "active_held_ms", "policy_generation", "host_calls" FROM `__old_run_lineages`;--> statement-breakpoint
DROP TABLE `__old_run_lineages`;--> statement-breakpoint
CREATE TABLE `__new_run_lineage_attempts` (
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
	`host_calls` integer DEFAULT 0 NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`resource` text DEFAULT '' NOT NULL,
	`step_hash` text DEFAULT '' NOT NULL,
	`calls_settled` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`run_id`, `step_key`, `attempt`, `generation`),
	FOREIGN KEY (`root_run_id`) REFERENCES `run_lineages`(`root_run_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_run_lineage_attempts`("run_id", "step_key", "attempt", "generation", "root_run_id", "reserved_ms", "deadline", "used_ms", "admitted_at", "settled_at", "policy_generation", "host_calls", "subject", "resource", "step_hash", "calls_settled") SELECT "run_id", "step_key", "attempt", "generation", "root_run_id", "reserved_ms", "deadline", "used_ms", "admitted_at", "settled_at", "policy_generation", "host_calls", "subject", "resource", "step_hash", "calls_settled" FROM `run_lineage_attempts`;--> statement-breakpoint
DROP TABLE `run_lineage_attempts`;--> statement-breakpoint
ALTER TABLE `__new_run_lineage_attempts` RENAME TO `run_lineage_attempts`;--> statement-breakpoint
CREATE INDEX `run_lineage_attempts_held_idx` ON `run_lineage_attempts` (`root_run_id`,`admitted_at`) WHERE settled_at IS NULL;--> statement-breakpoint
CREATE INDEX `run_lineage_attempts_running_idx` ON `run_lineage_attempts` (`admitted_at`) WHERE settled_at IS NULL;--> statement-breakpoint
CREATE INDEX `run_lineage_attempts_subject_idx` ON `run_lineage_attempts` (`subject`,`admitted_at`) WHERE settled_at IS NULL;--> statement-breakpoint
CREATE INDEX `run_lineage_attempts_resource_idx` ON `run_lineage_attempts` (`resource`,`admitted_at`) WHERE settled_at IS NULL;--> statement-breakpoint
ALTER TABLE `workflow_resource_runs` ADD `shares_fenced_through` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- The foreign keys these take the place of: a lineage only of a run core
-- has a row of, and an attempt only of one; neither moves to another run.
CREATE TRIGGER `run_lineages_of_runs` BEFORE INSERT ON `run_lineages`
WHEN NOT EXISTS (SELECT 1 FROM `workflow_runs` WHERE `id` = NEW.`root_run_id`)
	AND NOT EXISTS (SELECT 1 FROM `workflow_resource_runs` WHERE `id` = NEW.`root_run_id`)
BEGIN
	SELECT RAISE(ABORT, 'run_lineages are of runs core has');
END;
--> statement-breakpoint
CREATE TRIGGER `run_lineages_root_kept` BEFORE UPDATE OF `root_run_id` ON `run_lineages`
WHEN NEW.`root_run_id` IS NOT OLD.`root_run_id`
BEGIN
	SELECT RAISE(ABORT, 'a run lineage keeps its root');
END;
--> statement-breakpoint
CREATE TRIGGER `run_lineage_attempts_of_runs` BEFORE INSERT ON `run_lineage_attempts`
WHEN NOT EXISTS (SELECT 1 FROM `workflow_runs` WHERE `id` = NEW.`run_id`)
	AND NOT EXISTS (SELECT 1 FROM `workflow_resource_runs` WHERE `id` = NEW.`run_id`)
BEGIN
	SELECT RAISE(ABORT, 'run_lineage_attempts are of runs core has');
END;
--> statement-breakpoint
CREATE TRIGGER `run_lineage_attempts_run_kept` BEFORE UPDATE OF `run_id` ON `run_lineage_attempts`
WHEN NEW.`run_id` IS NOT OLD.`run_id`
BEGIN
	SELECT RAISE(ABORT, 'an attempt keeps its run');
END;
