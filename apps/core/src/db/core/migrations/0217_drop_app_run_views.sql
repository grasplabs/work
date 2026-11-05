DROP TABLE `workflow_owners`;--> statement-breakpoint
DROP TABLE `workflow_teams`;--> statement-breakpoint
ALTER TABLE `app_versions` DROP COLUMN `workflows`;--> statement-breakpoint
ALTER TABLE `notifications` DROP COLUMN `run_id`;--> statement-breakpoint
ALTER TABLE `notifications` DROP COLUMN `failures`;