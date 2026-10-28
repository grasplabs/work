ALTER TABLE `connections` ADD `tools_unsynced_at` integer;--> statement-breakpoint
ALTER TABLE `connections` ADD `tools_sync_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `tools_sync_retry_at` integer;