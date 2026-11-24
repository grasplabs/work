DROP INDEX `chats_person`;--> statement-breakpoint
ALTER TABLE `chats` ADD `last_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `chats_person` ON `chats` (`person_id`,`last_at`);