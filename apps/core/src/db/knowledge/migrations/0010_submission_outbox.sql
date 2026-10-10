CREATE TABLE `submission_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`intent` text NOT NULL,
	`created_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`settled_at` integer,
	`undeliverable` text,
	FOREIGN KEY (`receipt_id`) REFERENCES `submission_outcomes`(`receipt_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `submission_outbox_receipt_idx` ON `submission_outbox` (`receipt_id`);--> statement-breakpoint
CREATE INDEX `submission_outbox_pending_idx` ON `submission_outbox` (`next_attempt_at`) WHERE settled_at IS NULL;