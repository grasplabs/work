-- Each client's changes counted, and their kind, on its one operation
-- (src/hosting/operation.ts), and the change a rollout started on a
-- client: what a rollback reads to know it's still the latest.
ALTER TABLE `client_provisions` ADD `change` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `client_provisions` ADD `what` text;--> statement-breakpoint
ALTER TABLE `rollout_targets` ADD `change` integer;