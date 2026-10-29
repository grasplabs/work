PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_token_revocations` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`sealed` text NOT NULL,
	`reason` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Each revoke owed so far keeps the tokens it revokes with, copied from
-- the disconnected connection's own row, which then goes as for any
-- disconnected connection (src/revocations.ts).
INSERT INTO `__new_token_revocations`("id", "connection_id", "sealed", "reason", "attempts", "retry_at", "created_at") SELECT lower(hex(randomblob(16))), r."connection_id", t."sealed", 'disconnected', r."attempts", r."retry_at", r."created_at" FROM `token_revocations` r JOIN `connection_tokens` t ON t."connection_id" = r."connection_id";--> statement-breakpoint
DELETE FROM `connection_tokens` WHERE "connection_id" IN (SELECT "id" FROM `connections` WHERE "status" = 'disconnected');--> statement-breakpoint
DROP TABLE `token_revocations`;--> statement-breakpoint
ALTER TABLE `__new_token_revocations` RENAME TO `token_revocations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `token_revocations_retry_idx` ON `token_revocations` (`retry_at`);--> statement-breakpoint
CREATE INDEX `token_revocations_connection_idx` ON `token_revocations` (`connection_id`);