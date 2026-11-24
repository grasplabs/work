DROP TABLE `build_admission_queue`;--> statement-breakpoint
DROP TABLE `build_commit_fences`;--> statement-breakpoint
DROP TABLE `workflow_admission_queue`;--> statement-breakpoint
DROP INDEX `build_leases_resource_idx`;--> statement-breakpoint
ALTER TABLE `build_leases` DROP COLUMN `subject`;--> statement-breakpoint
ALTER TABLE `build_leases` DROP COLUMN `resource`;--> statement-breakpoint
DROP INDEX `run_lineage_attempts_subject_idx`;--> statement-breakpoint
ALTER TABLE `run_lineage_attempts` DROP COLUMN `subject`;--> statement-breakpoint
ALTER TABLE `run_lineage_attempts` DROP COLUMN `step_hash`;