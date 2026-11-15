ALTER TABLE `chat_run_sources` ADD `pinned_at` integer;--> statement-breakpoint
CREATE INDEX `chat_run_sources_pinned` ON `chat_run_sources` (`source_id`,`pinned_at`);