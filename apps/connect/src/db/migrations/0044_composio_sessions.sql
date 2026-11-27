ALTER TABLE `composio_cleanups` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `composio_flows` ADD `composio_user_id` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `composio_session_id` text;--> statement-breakpoint
UPDATE `connections` SET `status` = 'needs_reauth', `updated_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE `server_kind` = 'composio' AND `status` = 'active' AND `composio_session_id` IS NULL;--> statement-breakpoint
UPDATE `connections` SET `composio_server_id` = NULL WHERE `composio_server_id` IS NOT NULL;--> statement-breakpoint
UPDATE `composio_cleanups` SET `server_id` = NULL WHERE `server_id` IS NOT NULL;
