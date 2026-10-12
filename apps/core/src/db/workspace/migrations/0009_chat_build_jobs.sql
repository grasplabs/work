CREATE TABLE `chat_build_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`run_id` text NOT NULL,
	`app_id` text NOT NULL,
	`kind` text NOT NULL,
	`message` text,
	`revision` integer NOT NULL,
	`granted_at` integer NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`error` text,
	`intended_parent` integer,
	`intended_tree` text,
	`version` integer,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chat_build_jobs_status" CHECK("chat_build_jobs"."status" IN ('running', 'completed', 'failed', 'cancelled', 'revoked')),
	CONSTRAINT "chat_build_jobs_kind" CHECK("chat_build_jobs"."kind" IN ('check', 'propose'))
);
--> statement-breakpoint
CREATE INDEX `chat_build_jobs_chat` ON `chat_build_jobs` (`chat_id`,`created_at`);