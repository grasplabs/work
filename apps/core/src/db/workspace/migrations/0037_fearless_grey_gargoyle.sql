CREATE TABLE `held_app_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`person_id` text NOT NULL,
	`app_id` text NOT NULL,
	`function` text NOT NULL,
	`kind` text NOT NULL,
	`request` text,
	`request_hash` text NOT NULL,
	`held_at` integer NOT NULL,
	`status` text NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `held_app_calls_chat` ON `held_app_calls` (`chat_id`,`status`);--> statement-breakpoint
ALTER TABLE `chats` ADD `private_read` integer DEFAULT false NOT NULL;