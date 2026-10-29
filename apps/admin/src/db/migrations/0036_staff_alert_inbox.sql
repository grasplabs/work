CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text,
	`kind` text NOT NULL,
	`subject` text,
	`numbers` text NOT NULL,
	`open_key` text,
	`raised_at` integer NOT NULL,
	`last_raised_at` integer NOT NULL,
	`times` integer NOT NULL,
	`delivery` text NOT NULL,
	`acknowledged_by` text,
	`acknowledged_at` integer,
	`resolved_by` text,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_open_key_idx` ON `alerts` (`open_key`);--> statement-breakpoint
CREATE INDEX `alerts_resolved_idx` ON `alerts` (`resolved_at`,`raised_at`);--> statement-breakpoint
ALTER TABLE `release_import_failures` ADD `last_error` text;