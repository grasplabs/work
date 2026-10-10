CREATE TABLE `submission_outcomes` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`fence` integer NOT NULL,
	`open` integer NOT NULL,
	`on_time` integer NOT NULL,
	`current` integer NOT NULL,
	`outcome` text NOT NULL,
	`committed_at` integer NOT NULL,
	FOREIGN KEY (`receipt_id`,`fence`) REFERENCES `submission_receipts`(`id`,`fence`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "submission_outcomes_open" CHECK("submission_outcomes"."open" = 1),
	CONSTRAINT "submission_outcomes_on_time" CHECK("submission_outcomes"."on_time" = 1),
	CONSTRAINT "submission_outcomes_current" CHECK("submission_outcomes"."current" = 1)
);
--> statement-breakpoint
CREATE TABLE `submission_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`operation` text NOT NULL,
	`principal` text NOT NULL,
	`app_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`run_id` text,
	`input_hash` text NOT NULL,
	`fence` integer NOT NULL,
	`created_at` integer NOT NULL,
	`retain_until` integer NOT NULL,
	`expired_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submission_receipts_fence_idx` ON `submission_receipts` (`id`,`fence`);--> statement-breakpoint
CREATE INDEX `submission_receipts_retain_idx` ON `submission_receipts` (`retain_until`,`id`) WHERE expired_at IS NULL;--> statement-breakpoint
CREATE INDEX `submission_receipts_expired_idx` ON `submission_receipts` (`expired_at`,`id`) WHERE expired_at IS NOT NULL;