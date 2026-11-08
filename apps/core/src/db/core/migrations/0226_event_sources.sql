CREATE TABLE `event_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token` text,
	`secret_generation` integer NOT NULL,
	`secret_revoked_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_sources_token_unique` ON `event_sources` (`token`);--> statement-breakpoint
ALTER TABLE `trigger_resource_versions` ADD `event_source_id` text;--> statement-breakpoint
CREATE INDEX `trigger_resource_versions_source` ON `trigger_resource_versions` (`event_source_id`,`event_type`) WHERE "trigger_resource_versions"."event_source_id" IS NOT NULL;--> statement-breakpoint
-- Webhook triggers start on event sources from here on (GRA-1560): one
-- with a URL and secret of its own has no source, starts nothing, and no
-- longer answers at its URL. Nothing was released, so each is deleted, as
-- deleting a trigger does, and the permissions it asked for or held are
-- revoked. Each statement changes nothing run again. The columns stay for
-- an older core still serving (expand, then contract: GRA-1659).
UPDATE `permissions` SET `status` = 'revoked', `revoked_at` = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE `subject_type` = 'trigger' AND `status` != 'revoked' AND `subject_id` IN (SELECT `id` FROM `trigger_resources` WHERE `kind` = 'webhook' AND `deleted_at` IS NULL);--> statement-breakpoint
UPDATE `trigger_resources` SET `deleted_at` = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE `kind` = 'webhook' AND `deleted_at` IS NULL;
