ALTER TABLE `trigger_resources` ADD `webhook_token` text;--> statement-breakpoint
ALTER TABLE `trigger_resources` ADD `webhook_secret_generation` integer;--> statement-breakpoint
ALTER TABLE `trigger_resources` ADD `webhook_secret_revoked_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `trigger_resources_webhook_token_unique` ON `trigger_resources` (`webhook_token`);