CREATE TABLE `chat_workflow_offers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`workflow_name` text NOT NULL,
	`version` integer NOT NULL,
	`input` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`posted_at` integer,
	`platform` text,
	`thread_id` text,
	`locale` text,
	`pressed_at` integer,
	`start_id` text,
	`run_id` text,
	`told_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_workflow_offers_chat_idx` ON `chat_workflow_offers` (`chat_id`);--> statement-breakpoint
CREATE INDEX `chat_workflow_offers_run_idx` ON `chat_workflow_offers` (`run_id`);--> statement-breakpoint
CREATE INDEX `chat_workflow_offers_user_idx` ON `chat_workflow_offers` (`user_id`);--> statement-breakpoint
ALTER TABLE `workflow_resources` ADD `askable` integer DEFAULT false NOT NULL;