CREATE TABLE `chat_code_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`source_hash` text NOT NULL,
	`source_chars` integer NOT NULL,
	`agent` text NOT NULL,
	`compatibility_date` text NOT NULL,
	`runtime` text NOT NULL,
	`cpu_limit` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chat_code_runs_status" CHECK("chat_code_runs"."status" IN ('running', 'completed', 'threw', 'refused', 'load_failed', 'cpu_exceeded', 'crashed', 'wall_expired', 'cancelled', 'revoked', 'interrupted')),
	CONSTRAINT "chat_code_runs_tool_call_id" CHECK(length("chat_code_runs"."tool_call_id") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE INDEX `chat_code_runs_chat` ON `chat_code_runs` (`chat_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `chat_code_runs_running` ON `chat_code_runs` (`status`) WHERE status = 'running';