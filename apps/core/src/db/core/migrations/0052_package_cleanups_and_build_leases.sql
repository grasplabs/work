CREATE TABLE `dependency_build_leases` (
	`app_id` text NOT NULL,
	`graph_hash` text NOT NULL,
	`target` text NOT NULL,
	`holder` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `graph_hash`, `target`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dependency_build_leases_expires_at_idx` ON `dependency_build_leases` (`expires_at`);--> statement-breakpoint
CREATE TABLE `package_cleanups` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `package_cleanups_created_at_idx` ON `package_cleanups` (`created_at`);--> statement-breakpoint
ALTER TABLE `dependency_locks` ADD `served_until` integer;