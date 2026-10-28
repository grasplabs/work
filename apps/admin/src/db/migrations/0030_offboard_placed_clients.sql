-- Offboarding a placed client, and deleting its resources once the
-- retention window is over (src/hosting/offboarding.ts): when it was
-- offboarded, and when each resource was deleted.
ALTER TABLE `client_resources` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `clients` ADD `offboarded_at` integer;