CREATE TABLE `channel_conversations` (
	`platform` text NOT NULL,
	`thread_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_message_at` integer NOT NULL,
	PRIMARY KEY(`platform`, `thread_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `channel_conversations_user_id_idx` ON `channel_conversations` (`user_id`);--> statement-breakpoint
CREATE INDEX `accounts_oid_idx` ON `accounts` (`oid`);