CREATE TABLE `chat_documents` (
	`chat_id` text NOT NULL,
	`document_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`chat_id`, `document_id`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chat_documents_age` ON `chat_documents` (`chat_id`,`created_at`);