CREATE TABLE `chat_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`surface` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`sent_at` integer NOT NULL,
	`first_request_ms` integer,
	`first_token_ms` integer,
	`first_text_ms` integer,
	`done_ms` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`cost` real NOT NULL,
	`tools` text NOT NULL,
	`retries` integer NOT NULL,
	`fallbacks` integer NOT NULL,
	`rate_limit_waits` integer NOT NULL,
	`rate_limit_wait_ms` integer NOT NULL,
	`stop_reason` text,
	`outcome` text NOT NULL,
	`code` text,
	`compacted` integer NOT NULL,
	`resumed` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_turns_sent_idx` ON `chat_turns` (`sent_at`);