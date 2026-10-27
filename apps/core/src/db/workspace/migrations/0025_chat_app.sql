ALTER TABLE `chats` ADD `app_id` text;--> statement-breakpoint
CREATE INDEX `chats_app` ON `chats` (`person_id`,`app_id`);