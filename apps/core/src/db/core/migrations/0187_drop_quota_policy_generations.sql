-- The quota limits are the platform's, in code (src/workflows/quotas.ts): no policy generation is recorded or kept. Hard cut: nothing was released.
DROP TABLE `quota_policies`;--> statement-breakpoint
ALTER TABLE `build_leases` DROP COLUMN `policy_generation`;--> statement-breakpoint
ALTER TABLE `run_lineage_attempts` DROP COLUMN `policy_generation`;--> statement-breakpoint
ALTER TABLE `run_lineages` DROP COLUMN `policy_generation`;