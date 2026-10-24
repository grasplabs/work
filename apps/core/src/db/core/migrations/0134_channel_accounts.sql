CREATE TABLE `channel_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`platform_user_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text,
	`linked_at` integer NOT NULL,
	`linked_how` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_accounts_platform_user_idx` ON `channel_accounts` (`platform`,`platform_user_id`);--> statement-breakpoint
CREATE INDEX `channel_accounts_user_id_idx` ON `channel_accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `channel_links` (
	`secret_hash` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`platform_user_id` text NOT NULL,
	`name` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by` text,
	`replaced_at` integer
);
--> statement-breakpoint
CREATE INDEX `channel_links_platform_user_idx` ON `channel_links` (`platform`,`platform_user_id`);--> statement-breakpoint
CREATE INDEX `channel_links_expires_at_idx` ON `channel_links` (`expires_at`);