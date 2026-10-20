-- A workflow's runs, newest first, for its page's Runs tab
-- (`listResourceRuns`, GRA-674).
CREATE INDEX `workflow_resource_runs_newest_idx` ON `workflow_resource_runs` (`workflow_resource_id`,`created_at`,`id`);