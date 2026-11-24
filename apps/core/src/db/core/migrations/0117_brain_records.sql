CREATE TABLE `brain_records` (
	`position` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`id` text NOT NULL,
	`body` text NOT NULL,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brain_records_id_idx` ON `brain_records` (`id`);