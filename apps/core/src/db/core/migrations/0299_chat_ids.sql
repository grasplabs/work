CREATE TABLE `chat_ids` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`request_key` text,
	`created_at` integer NOT NULL
);
