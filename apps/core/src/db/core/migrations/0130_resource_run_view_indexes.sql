-- An independent workflow's runs, read as an App's are
-- (src/workflows/run-view.ts): across workflows newest first, and those
-- ended in a window by how they ended.
CREATE INDEX `workflow_resource_runs_created_idx` ON `workflow_resource_runs` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_resource_runs_status_ended_idx` ON `workflow_resource_runs` (`status`,`ended_at`,`id`);