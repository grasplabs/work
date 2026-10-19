PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_access_revocations` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text,
	`user_ids` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`after_app_id` text,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_access_revocations`("id", "app_id", "user_ids", "attempts", "created_at", "after_app_id") SELECT "id", "app_id", "user_ids", "attempts", "created_at", "after_app_id" FROM `access_revocations`;--> statement-breakpoint
DROP TABLE `access_revocations`;--> statement-breakpoint
ALTER TABLE `__new_access_revocations` RENAME TO `access_revocations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `access_revocations_due` ON `access_revocations` (`attempts`,`created_at`);--> statement-breakpoint
CREATE INDEX `access_revocations_age` ON `access_revocations` (`created_at`);