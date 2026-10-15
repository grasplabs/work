CREATE TABLE `access_revocations` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`user_ids` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
