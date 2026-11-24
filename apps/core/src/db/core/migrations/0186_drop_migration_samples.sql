-- The migration dry run on sample records is gone (it had no caller):
-- fixture evidence alone gates making a release current
-- (migration-evidence.ts). Dropping a table drops its triggers.
DROP TABLE `migration_sample_leases`;--> statement-breakpoint
DROP TABLE `migration_samples`;