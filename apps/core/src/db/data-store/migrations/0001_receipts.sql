CREATE TABLE `sdk_change_outbox` (
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
	FOREIGN KEY (`receipt_id`) REFERENCES `sdk_mutation_receipts`(`receipt_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sdk_change_outbox_receipt` ON `sdk_change_outbox` (`receipt_id`);--> statement-breakpoint
CREATE INDEX `sdk_change_outbox_pending` ON `sdk_change_outbox` (`next_attempt_at`) WHERE settled_at IS NULL;--> statement-breakpoint
CREATE TABLE `sdk_mutation_receipts` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`principal` text NOT NULL,
	`run_id` text,
	`input_hash` text NOT NULL,
	`fence` integer NOT NULL,
	`deadline` integer NOT NULL,
	`created_at` integer NOT NULL,
	`retain_until` integer NOT NULL,
	`expired_at` integer,
	`outcome` text,
	`committed_at` integer,
	`commit` integer,
	CONSTRAINT "sdk_mutation_receipts_fence" CHECK("sdk_mutation_receipts"."fence" >= 1),
	CONSTRAINT "sdk_mutation_receipts_committed" CHECK(("sdk_mutation_receipts"."outcome" IS NULL) = ("sdk_mutation_receipts"."committed_at" IS NULL) AND ("sdk_mutation_receipts"."outcome" IS NULL) = ("sdk_mutation_receipts"."commit" IS NULL)),
	CONSTRAINT "sdk_mutation_receipts_tombstone" CHECK("sdk_mutation_receipts"."expired_at" IS NULL OR "sdk_mutation_receipts"."outcome" IS NULL)
);
--> statement-breakpoint
CREATE INDEX `sdk_mutation_receipts_retain` ON `sdk_mutation_receipts` (`retain_until`) WHERE expired_at IS NULL;--> statement-breakpoint
CREATE INDEX `sdk_mutation_receipts_expired` ON `sdk_mutation_receipts` (`expired_at`) WHERE expired_at IS NOT NULL;--> statement-breakpoint
ALTER TABLE `sdk_store` ADD `commits` integer DEFAULT 0 NOT NULL;