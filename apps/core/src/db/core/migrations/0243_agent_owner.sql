ALTER TABLE `agents` ADD `owner_id` text;--> statement-breakpoint
CREATE INDEX `agents_owner_idx` ON `agents` (`owner_id`) WHERE "agents"."owner_id" IS NOT NULL;