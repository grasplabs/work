CREATE TABLE `chat_draft_contents` (
	`chat_id` text NOT NULL,
	`app_id` text NOT NULL,
	`sha256` text NOT NULL,
	`content` text NOT NULL,
	PRIMARY KEY(`chat_id`, `app_id`, `sha256`)
);
--> statement-breakpoint
CREATE TABLE `chat_draft_version_files` (
	`chat_id` text NOT NULL,
	`app_id` text NOT NULL,
	`number` integer NOT NULL,
	`path` text NOT NULL,
	`sha256` text,
	PRIMARY KEY(`chat_id`, `app_id`, `number`, `path`),
	FOREIGN KEY (`chat_id`,`app_id`,`number`) REFERENCES `chat_draft_versions`(`chat_id`,`app_id`,`number`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `chat_draft_versions` (
	`chat_id` text NOT NULL,
	`app_id` text NOT NULL,
	`number` integer NOT NULL,
	`revision` integer NOT NULL,
	`base` integer,
	`content_hash` text NOT NULL,
	`call_id` text,
	`restored_from` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`chat_id`, `app_id`, `number`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
