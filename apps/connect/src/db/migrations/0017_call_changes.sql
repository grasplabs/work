CREATE TABLE `call_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`action` text NOT NULL,
	`resource` text,
	`on_behalf_of` text NOT NULL,
	`change` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `call_changes_hash_idx` ON `call_changes` (`hash`);