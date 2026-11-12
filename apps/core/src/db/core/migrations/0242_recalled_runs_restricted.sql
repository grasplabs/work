-- A run's restricted mode may now be entered once while it runs, never
-- left: a recall of the Brain puts its run in restricted mode before the
-- run gets the pack (workflows/brain-calls.ts). Everything else a run
-- pins stays as its start wrote it, and an ended run stays ended.
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
	AND (NEW.`restricted` IS OLD.`restricted` OR (OLD.`restricted` = 0 AND NEW.`restricted` = 1))
	AND NEW.`parent_run_id` IS OLD.`parent_run_id`
	AND NEW.`root_run_id` IS OLD.`root_run_id`
	AND NEW.`depth` IS OLD.`depth`
	AND NEW.`account_run_id` IS OLD.`account_run_id`
) BEGIN
	SELECT RAISE(ABORT, 'workflow_resource_runs pin what they run, and an ended run stays ended');
END;
