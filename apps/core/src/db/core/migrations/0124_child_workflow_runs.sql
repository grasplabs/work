ALTER TABLE `workflow_resource_runs` ADD `parent_run_id` text;--> statement-breakpoint
ALTER TABLE `workflow_resource_runs` ADD `root_run_id` text;--> statement-breakpoint
ALTER TABLE `workflow_resource_runs` ADD `depth` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `workflow_resource_runs_parent_idx` ON `workflow_resource_runs` (`parent_run_id`,`status`) WHERE "workflow_resource_runs"."parent_run_id" IS NOT NULL;--> statement-breakpoint
-- A child run's parent, its lineage's root and its depth are written once,
-- with its row, and never change (workflows/run-children.ts): the trigger
-- that keeps a run's pins as they were written now covers them too.
DROP TRIGGER `workflow_resource_runs_pinned`;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_runs_pinned` BEFORE UPDATE ON `workflow_resource_runs`
WHEN OLD.`status` IN ('completed', 'failed', 'cancelled') OR NOT (
	NEW.`id` IS OLD.`id`
	AND NEW.`workflow_resource_id` IS OLD.`workflow_resource_id`
	AND NEW.`version` IS OLD.`version`
	AND NEW.`manifest_hash` IS OLD.`manifest_hash`
	AND NEW.`build_hash` IS OLD.`build_hash`
	AND NEW.`principal_id` IS OLD.`principal_id`
	AND NEW.`created_at` IS OLD.`created_at`
	AND NEW.`restricted` IS OLD.`restricted`
	AND NEW.`parent_run_id` IS OLD.`parent_run_id`
	AND NEW.`root_run_id` IS OLD.`root_run_id`
	AND NEW.`depth` IS OLD.`depth`
) BEGIN
	SELECT RAISE(ABORT, 'workflow_resource_runs pin what they run, and an ended run stays ended');
END;
