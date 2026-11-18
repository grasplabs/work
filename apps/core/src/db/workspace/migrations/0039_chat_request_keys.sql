CREATE TABLE `chat_request_keys` (
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`chat_id` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`kind`, `key`)
);
--> statement-breakpoint
CREATE INDEX `chat_request_keys_at` ON `chat_request_keys` (`at`);