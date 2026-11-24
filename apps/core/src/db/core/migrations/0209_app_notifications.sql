ALTER TABLE `notifications` ADD `title` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `body` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `screen` text;--> statement-breakpoint
CREATE INDEX `notifications_app_sent_idx` ON `notifications` (`app_id`,`created_at`) WHERE type = 'app_message';