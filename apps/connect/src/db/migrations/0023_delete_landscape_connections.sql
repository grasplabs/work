-- The Landscape's Microsoft admin connections, with their tokens and everything recorded for them: connect no longer knows the provider (it was removed with the Landscape).
DELETE FROM `connection_tokens` WHERE `connection_id` IN (SELECT `id` FROM `connections` WHERE `provider` = 'microsoft-landscape');--> statement-breakpoint
DELETE FROM `token_revocations` WHERE `connection_id` IN (SELECT `id` FROM `connections` WHERE `provider` = 'microsoft-landscape');--> statement-breakpoint
DELETE FROM `idempotent_calls` WHERE `connection_id` IN (SELECT `id` FROM `connections` WHERE `provider` = 'microsoft-landscape');--> statement-breakpoint
DELETE FROM `pending_actions` WHERE `connection_id` IN (SELECT `id` FROM `connections` WHERE `provider` = 'microsoft-landscape');--> statement-breakpoint
DELETE FROM `call_changes` WHERE `connection_id` IN (SELECT `id` FROM `connections` WHERE `provider` = 'microsoft-landscape');--> statement-breakpoint
DELETE FROM `event_sources` WHERE `connection_id` IN (SELECT `id` FROM `connections` WHERE `provider` = 'microsoft-landscape');--> statement-breakpoint
DELETE FROM `connector_events` WHERE `connection_id` IN (SELECT `id` FROM `connections` WHERE `provider` = 'microsoft-landscape');--> statement-breakpoint
DELETE FROM `connections` WHERE `provider` = 'microsoft-landscape';
