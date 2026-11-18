CREATE TABLE `chat_request_keys` (
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`chat_id` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`kind`, `key`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chat_request_keys_at` ON `chat_request_keys` (`at`);