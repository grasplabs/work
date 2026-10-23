CREATE TABLE `brain_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`scope` text NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`statement` text NOT NULL,
	`source_refs` text NOT NULL,
	`state` text NOT NULL,
	`indexing_state` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `brain_memories_owner_idx` ON `brain_memories` (`owner_id`,`recorded_at`,`id`);--> statement-breakpoint
CREATE INDEX `brain_memories_owner_kind_idx` ON `brain_memories` (`owner_id`,`kind`,`recorded_at`,`id`);--> statement-breakpoint
CREATE TABLE `brain_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`key_hash` text NOT NULL,
	`caller` text NOT NULL,
	`operation` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text NOT NULL,
	`indexing_state` text NOT NULL,
	`resource_refs` text NOT NULL,
	`created_at` integer NOT NULL,
	`retention_until` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brain_receipts_key_idx` ON `brain_receipts` (`key_hash`);--> statement-breakpoint
CREATE INDEX `brain_receipts_retention_idx` ON `brain_receipts` (`retention_until`);--> statement-breakpoint
CREATE INDEX `brain_receipts_caller_idx` ON `brain_receipts` (`caller`,`created_at`);