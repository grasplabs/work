DROP TABLE `collection_teams`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text,
	`face` text NOT NULL,
	`job` text NOT NULL,
	`instructions` text,
	`model_role` text,
	`model` text,
	`state` text NOT NULL,
	`owner_id` text,
	`offered_at` integer,
	`made_by` text NOT NULL,
	`made_at` integer NOT NULL,
	`changed_by` text NOT NULL,
	`changed_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_agents`("id", "name", "name_key", "face", "job", "instructions", "model_role", "model", "state", "owner_id", "offered_at", "made_by", "made_at", "changed_by", "changed_at") SELECT "id", "name", "name_key", "face", "job", "instructions", "model_role", "model", "state", "owner_id", "offered_at", "made_by", "made_at", "changed_by", "changed_at" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_name_key_idx` ON `agents` (`name_key`);--> statement-breakpoint
CREATE INDEX `agents_owner_idx` ON `agents` (`owner_id`) WHERE "agents"."owner_id" IS NOT NULL;--> statement-breakpoint
-- Grants on a Knowledge collection, a kind nothing serves since Knowledge
-- went (GRA-1735). Nothing is released (hard cut): an App that once held
-- one is no longer refused for it. Changes nothing run again.
DELETE FROM `permissions` WHERE `object_type` = 'collection';
