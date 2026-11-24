-- The contract half of release channels: rollout jobs, their targets, rings and the release feature flag the semver display counted, which nothing reads since.
DROP TABLE `rollout_targets`;--> statement-breakpoint
DROP TABLE `rollouts`;--> statement-breakpoint
DROP INDEX `clients_status_ring_idx`;--> statement-breakpoint
ALTER TABLE `clients` DROP COLUMN `ring`;--> statement-breakpoint
ALTER TABLE `releases` DROP COLUMN `feature`;