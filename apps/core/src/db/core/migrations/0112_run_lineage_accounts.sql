CREATE TABLE `run_lineage_accounts` (
	`root_run_id` text NOT NULL,
	`app_id` text NOT NULL,
	`kind` text NOT NULL,
	`account_run_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`root_run_id`, `app_id`, `kind`),
	FOREIGN KEY (`root_run_id`) REFERENCES `run_lineages`(`root_run_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `account_run_id` text;--> statement-breakpoint
CREATE TRIGGER `workflow_runs_account_kept` BEFORE UPDATE OF `account_run_id` ON `workflow_runs`
WHEN OLD.`account_run_id` IS NOT NULL AND NEW.`account_run_id` IS NOT OLD.`account_run_id`
BEGIN
	SELECT RAISE(ABORT, 'a run keeps its account');
END;
--> statement-breakpoint
CREATE TRIGGER `run_lineage_accounts_kept` BEFORE UPDATE ON `run_lineage_accounts`
BEGIN
	SELECT RAISE(ABORT, 'a lineage account is never changed');
END;
--> statement-breakpoint
CREATE TRIGGER `run_lineage_accounts_not_deleted` BEFORE DELETE ON `run_lineage_accounts`
BEGIN
	SELECT RAISE(ABORT, 'a lineage account is never deleted');
END;
