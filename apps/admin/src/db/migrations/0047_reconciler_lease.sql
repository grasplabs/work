-- The reconciler's lease: one tick at a time acts (src/rollout/reconciler.ts).
CREATE TABLE `reconciler_lease` (
	`id` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`expires_at` integer NOT NULL
);
