PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pending_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`on_behalf_of` text NOT NULL,
	`mode` text NOT NULL,
	`app_version` integer,
	`connection_id` text NOT NULL,
	`account_id` text,
	`resource` text,
	`action` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`input` text NOT NULL,
	`input_hash` text NOT NULL,
	`permission_id` text,
	`context` text NOT NULL,
	`restricted` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`binding` text,
	`stamp` text,
	`ends_at` integer,
	`unattended` integer DEFAULT false NOT NULL,
	`chat_app` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_pending_actions`("id", "subject_type", "subject_id", "on_behalf_of", "mode", "app_version", "connection_id", "account_id", "resource", "action", "idempotency_key", "input", "input_hash", "permission_id", "context", "restricted", "created_at", "binding", "stamp", "ends_at", "unattended", "chat_app") SELECT "id", "subject_type", "subject_id", "on_behalf_of", "mode", "app_version", "connection_id", "account_id", "resource", "action", "idempotency_key", "input", "input_hash", "permission_id", "context", "restricted", "created_at", "binding", "stamp", "ends_at", "unattended", "chat_app" FROM `pending_actions`;--> statement-breakpoint
DROP TABLE `pending_actions`;--> statement-breakpoint
ALTER TABLE `__new_pending_actions` RENAME TO `pending_actions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `pending_actions_call_idx` ON `pending_actions` (`subject_type`,`subject_id`,`on_behalf_of`,`connection_id`,`action`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `pending_actions_person_idx` ON `pending_actions` (`on_behalf_of`);--> statement-breakpoint
CREATE INDEX `pending_actions_connection_idx` ON `pending_actions` (`connection_id`);--> statement-breakpoint
CREATE INDEX `pending_actions_key_idx` ON `pending_actions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `pending_actions_ends_idx` ON `pending_actions` (`ends_at`) WHERE "pending_actions"."ends_at" IS NOT NULL;