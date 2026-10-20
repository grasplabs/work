-- Test runs of a workflow's draft checkpoint, never published
-- (workflows/candidate-runs.ts, GRA-815).
CREATE TABLE `workflow_candidate_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_resource_id` text NOT NULL,
	`draft_revision` integer NOT NULL,
	`manifest` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`build_hash` text NOT NULL,
	`reservation` text NOT NULL,
	`principal_id` text NOT NULL,
	`input` text NOT NULL,
	`params` text NOT NULL,
	`fixtures` text NOT NULL,
	`status` text NOT NULL,
	`engine_sequence` integer DEFAULT 0 NOT NULL,
	`shares_fenced_through` integer DEFAULT 0 NOT NULL,
	`failure_code` text,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_candidate_runs_workflow_idx` ON `workflow_candidate_runs` (`workflow_resource_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_candidate_runs_created_idx` ON `workflow_candidate_runs` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_candidate_runs_reservation_idx` ON `workflow_candidate_runs` (`reservation`);
--> statement-breakpoint
-- A test run's attempts are admitted, and counted, as any run's: its row
-- roots a lineage (workflows/quotas.ts, `lineageCreated`).
DROP TRIGGER `run_lineages_of_runs`;--> statement-breakpoint
CREATE TRIGGER `run_lineages_of_runs` BEFORE INSERT ON `run_lineages`
WHEN NOT EXISTS (SELECT 1 FROM `workflow_runs` WHERE `id` = NEW.`root_run_id`)
	AND NOT EXISTS (SELECT 1 FROM `workflow_resource_runs` WHERE `id` = NEW.`root_run_id`)
	AND NOT EXISTS (SELECT 1 FROM `workflow_candidate_runs` WHERE `id` = NEW.`root_run_id`)
BEGIN
	SELECT RAISE(ABORT, 'run_lineages are of runs core has');
END;--> statement-breakpoint
DROP TRIGGER `run_lineage_attempts_of_runs`;--> statement-breakpoint
CREATE TRIGGER `run_lineage_attempts_of_runs` BEFORE INSERT ON `run_lineage_attempts`
WHEN NOT EXISTS (SELECT 1 FROM `workflow_runs` WHERE `id` = NEW.`run_id`)
	AND NOT EXISTS (SELECT 1 FROM `workflow_resource_runs` WHERE `id` = NEW.`run_id`)
	AND NOT EXISTS (SELECT 1 FROM `workflow_candidate_runs` WHERE `id` = NEW.`run_id`)
BEGIN
	SELECT RAISE(ABORT, 'run_lineage_attempts are of runs core has');
END;
--> statement-breakpoint
-- A test run's row pins what it runs, as whom and with what: only where
-- the engine has it changes (candidate-runs.ts).
CREATE TRIGGER `workflow_candidate_runs_pinned` BEFORE UPDATE OF `workflow_resource_id`, `manifest`, `manifest_hash`, `build_hash`, `reservation`, `principal_id`, `input`, `params`, `fixtures` ON `workflow_candidate_runs`
WHEN NEW.`workflow_resource_id` IS NOT OLD.`workflow_resource_id`
	OR NEW.`manifest` IS NOT OLD.`manifest`
	OR NEW.`manifest_hash` IS NOT OLD.`manifest_hash`
	OR NEW.`build_hash` IS NOT OLD.`build_hash`
	OR NEW.`reservation` IS NOT OLD.`reservation`
	OR NEW.`principal_id` IS NOT OLD.`principal_id`
	OR NEW.`input` IS NOT OLD.`input`
	OR NEW.`params` IS NOT OLD.`params`
	OR NEW.`fixtures` IS NOT OLD.`fixtures`
BEGIN
	SELECT RAISE(ABORT, 'workflow_candidate_runs pin what they run');
END;
