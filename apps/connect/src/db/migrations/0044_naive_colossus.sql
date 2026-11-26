CREATE TABLE `connector_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`connector` text NOT NULL,
	`source` text NOT NULL,
	`code` text NOT NULL,
	`manifest` text NOT NULL,
	`provenance` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `connector_versions_connector_idx` ON `connector_versions` (`connector`);--> statement-breakpoint
ALTER TABLE `connectors` ADD `server` text;--> statement-breakpoint
ALTER TABLE `connectors` ADD `version` text REFERENCES connector_versions(id);--> statement-breakpoint
CREATE UNIQUE INDEX `connectors_server_idx` ON `connectors` (`server`);--> statement-breakpoint
-- A connector made from a URL before this release has no version, which
-- this release reads it by: it goes, with everything kept of its
-- connections, for an admin to add again (no backfill). Children first,
-- for the foreign keys.
DELETE FROM `connector_blocked_tools` WHERE `connector_id` IN (SELECT `id` FROM `connectors` WHERE `id` LIKE 'mcp\_%' ESCAPE '\' AND `version` IS NULL);--> statement-breakpoint
DELETE FROM `pending_actions` WHERE `connection_id` IN (SELECT `id` FROM `connections` WHERE `server_kind` = 'connector' AND `server` IN (SELECT `id` FROM `connectors` WHERE `id` LIKE 'mcp\_%' ESCAPE '\' AND `version` IS NULL));--> statement-breakpoint
DELETE FROM `connection_tools` WHERE `connection_id` IN (SELECT `id` FROM `connections` WHERE `server_kind` = 'connector' AND `server` IN (SELECT `id` FROM `connectors` WHERE `id` LIKE 'mcp\_%' ESCAPE '\' AND `version` IS NULL));--> statement-breakpoint
DELETE FROM `token_revocations` WHERE `connection_id` IN (SELECT `id` FROM `connections` WHERE `server_kind` = 'connector' AND `server` IN (SELECT `id` FROM `connectors` WHERE `id` LIKE 'mcp\_%' ESCAPE '\' AND `version` IS NULL));--> statement-breakpoint
DELETE FROM `given_up_revocations` WHERE `connection_id` IN (SELECT `id` FROM `connections` WHERE `server_kind` = 'connector' AND `server` IN (SELECT `id` FROM `connectors` WHERE `id` LIKE 'mcp\_%' ESCAPE '\' AND `version` IS NULL));--> statement-breakpoint
DELETE FROM `sync_picks` WHERE `connection_id` IN (SELECT `id` FROM `connections` WHERE `server_kind` = 'connector' AND `server` IN (SELECT `id` FROM `connectors` WHERE `id` LIKE 'mcp\_%' ESCAPE '\' AND `version` IS NULL));--> statement-breakpoint
DELETE FROM `connection_tenant_tokens` WHERE `connection_id` IN (SELECT `id` FROM `connections` WHERE `server_kind` = 'connector' AND `server` IN (SELECT `id` FROM `connectors` WHERE `id` LIKE 'mcp\_%' ESCAPE '\' AND `version` IS NULL));--> statement-breakpoint
DELETE FROM `connection_tokens` WHERE `connection_id` IN (SELECT `id` FROM `connections` WHERE `server_kind` = 'connector' AND `server` IN (SELECT `id` FROM `connectors` WHERE `id` LIKE 'mcp\_%' ESCAPE '\' AND `version` IS NULL));--> statement-breakpoint
DELETE FROM `connections` WHERE `id` IN (SELECT `id` FROM `connections` WHERE `server_kind` = 'connector' AND `server` IN (SELECT `id` FROM `connectors` WHERE `id` LIKE 'mcp\_%' ESCAPE '\' AND `version` IS NULL));--> statement-breakpoint
DELETE FROM `oauth_flows` WHERE `provider` IN (SELECT `id` FROM `connectors` WHERE `id` LIKE 'mcp\_%' ESCAPE '\' AND `version` IS NULL);--> statement-breakpoint
DELETE FROM `connectors` WHERE `id` LIKE 'mcp\_%' ESCAPE '\' AND `version` IS NULL;
