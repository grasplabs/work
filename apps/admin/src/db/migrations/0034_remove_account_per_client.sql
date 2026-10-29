-- The account-per-client path is gone (hard cut): every client is placed
-- in a hosting destination, provisioned and released by its operation
-- (src/hosting/operation.ts). Its deploys' table and the client's own
-- account and workers.dev subdomain go with it.
DROP TABLE `client_deploys`;--> statement-breakpoint
DROP INDEX `clients_account_id_unique`;--> statement-breakpoint
ALTER TABLE `clients` DROP COLUMN `account_id`;--> statement-breakpoint
ALTER TABLE `clients` DROP COLUMN `workers_subdomain`;