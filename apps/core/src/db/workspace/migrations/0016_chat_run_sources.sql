CREATE TABLE `chat_run_sources` (
	`chat_id` text NOT NULL,
	`run_id` text NOT NULL,
	`source_id` text NOT NULL,
	`withheld_at` integer,
	PRIMARY KEY(`chat_id`, `run_id`, `source_id`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
