-- Clients created as placements in a hosting destination (src/hosting/,
-- hard cut from adopting an account per client): `clients.account_id`
-- becomes optional, null for every client added since, and `client_runs`
-- loses its `provision` kind's default, as the Workflow that adopted
-- accounts is gone. SQLite changes a column only by making its table
-- again. D1 ignores `PRAGMA foreign_keys = OFF`, so the keys are checked
-- at the commit instead (as core's 0123 does), and nothing that references
-- `clients` cascades. `clients` is copied aside, dropped, made again under
-- its own name and filled from the copy: rows that refer to it count as
-- orphaned once it's dropped, and only rows put back into a table named
-- `clients` count them as found again, which a table renamed into place
-- doesn't. A claim of that Workflow's kind names
-- an instance no binding reaches any more: it's dropped, so no read of
-- the client's runner asks a Workflow that isn't there.
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
DELETE FROM `client_runs` WHERE `kind` = 'provision';--> statement-breakpoint
CREATE TABLE `__new_client_runs` (
	`client_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`claimed_at` integer NOT NULL,
	`kind` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_client_runs`("client_id", "run_id", "claimed_at", "kind") SELECT "client_id", "run_id", "claimed_at", "kind" FROM `client_runs`;--> statement-breakpoint
DROP TABLE `client_runs`;--> statement-breakpoint
ALTER TABLE `__new_client_runs` RENAME TO `client_runs`;--> statement-breakpoint
CREATE TABLE `clients_before_0028` AS SELECT * FROM `clients`;--> statement-breakpoint
DROP TABLE `clients`;--> statement-breakpoint
CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`account_id` text,
	`generation` integer DEFAULT 1 NOT NULL,
	`rotated_at` integer,
	`rotation_live_at` integer,
	`workers_subdomain` text,
	`ring` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'provisioning' NOT NULL,
	`created_by` text,
	`sign_in` text,
	`teams_bot` text,
	`config_changed_at` integer,
	`stripe_customer_id` text,
	`rooms_project_id` text,
	`attio_company_id` text,
	`pinned_release_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`pinned_release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `clients`("id", "name", "account_id", "generation", "rotated_at", "rotation_live_at", "workers_subdomain", "ring", "status", "created_by", "sign_in", "teams_bot", "config_changed_at", "stripe_customer_id", "rooms_project_id", "attio_company_id", "pinned_release_id", "created_at", "updated_at") SELECT "id", "name", "account_id", "generation", "rotated_at", "rotation_live_at", "workers_subdomain", "ring", "status", "created_by", "sign_in", "teams_bot", "config_changed_at", "stripe_customer_id", "rooms_project_id", "attio_company_id", "pinned_release_id", "created_at", "updated_at" FROM `clients_before_0028`;--> statement-breakpoint
DROP TABLE `clients_before_0028`;--> statement-breakpoint
CREATE UNIQUE INDEX `clients_account_id_unique` ON `clients` (`account_id`);--> statement-breakpoint
CREATE INDEX `clients_status_ring_idx` ON `clients` (`status`,`ring`);