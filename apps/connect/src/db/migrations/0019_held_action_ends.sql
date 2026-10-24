ALTER TABLE `pending_actions` ADD `ends_at` integer;--> statement-breakpoint
CREATE INDEX `pending_actions_ends_idx` ON `pending_actions` (`ends_at`) WHERE "pending_actions"."ends_at" IS NOT NULL;