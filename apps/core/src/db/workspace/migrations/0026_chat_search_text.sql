CREATE TABLE `chat_search_text` (
	`message_id` integer PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`said` text NOT NULL,
	`folded` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chat_search_text_chat` ON `chat_search_text` (`chat_id`,`message_id`);