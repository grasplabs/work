CREATE TABLE `mail_outbox` (
	`key` text PRIMARY KEY NOT NULL,
	`about` text,
	`to_address` text NOT NULL,
	`mail` text NOT NULL,
	`fill` text,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` integer NOT NULL,
	`queued_at` text NOT NULL,
	`settled_at` text,
	`reason` text,
	`message_id` text
);
--> statement-breakpoint
CREATE INDEX `mail_outbox_due` ON `mail_outbox` (`state`,`next_at`);