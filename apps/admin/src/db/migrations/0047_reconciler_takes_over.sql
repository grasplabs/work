-- The reconciler takes over from rollout jobs: the shared secrets staff roll out become desired state, and a client an old rollout or rollback last held is held by a deploy the admin doesn't have, which the next claim replaces.
CREATE TABLE `rolled_out_secrets` (
	`id` integer PRIMARY KEY NOT NULL,
	`prints` text NOT NULL,
	`rotated` text NOT NULL,
	`rolled_out_by` text NOT NULL,
	`rolled_out_at` integer NOT NULL
);--> statement-breakpoint
UPDATE `client_runs` SET `kind` = 'deploy' WHERE `kind` IN ('rollout', 'rollback');