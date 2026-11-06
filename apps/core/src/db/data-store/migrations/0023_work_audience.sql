ALTER TABLE `sdk_migration_work` RENAME COLUMN "owner_id" TO "audience";--> statement-breakpoint
DROP INDEX `sdk_migration_work_batches`;--> statement-breakpoint
CREATE INDEX `sdk_migration_work_batches` ON `sdk_migration_work` (`target_hash`,`table_id`,`audience`,`record_id`);