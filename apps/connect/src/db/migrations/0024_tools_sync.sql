CREATE TABLE `composio_tool_sends` (
	`connection_id` text NOT NULL,
	`seq` integer NOT NULL,
	`sent_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `seq`)
);
--> statement-breakpoint
ALTER TABLE `connections` ADD `tools_sent_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `tools_settled_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `tools_sync_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `tools_sync_retry_at` integer;