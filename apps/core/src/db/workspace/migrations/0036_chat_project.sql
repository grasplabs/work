ALTER TABLE `chats` ADD `project_id` text;--> statement-breakpoint
CREATE INDEX `chats_project` ON `chats` (`person_id`,`project_id`);