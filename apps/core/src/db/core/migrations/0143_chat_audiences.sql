CREATE TABLE `chat_audiences` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`members` text NOT NULL,
	`outsiders` integer NOT NULL,
	`updated_at` integer NOT NULL
);
