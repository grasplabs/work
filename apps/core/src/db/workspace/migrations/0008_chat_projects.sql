CREATE TABLE `chat_project_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`content` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `chat_projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_project_documents_name` ON `chat_project_documents` (`project_id`,`name`);--> statement-breakpoint
CREATE TABLE `chat_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`name` text NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_projects_person` ON `chat_projects` (`person_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `chats` ADD `project_id` text;--> statement-breakpoint
CREATE INDEX `chats_project` ON `chats` (`project_id`);