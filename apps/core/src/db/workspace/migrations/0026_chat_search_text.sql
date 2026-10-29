CREATE TABLE `chat_search_text` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`said` text NOT NULL,
	`folded` text NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
