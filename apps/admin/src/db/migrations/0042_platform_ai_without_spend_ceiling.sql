CREATE TABLE `platform_ai` (
	`id` integer PRIMARY KEY NOT NULL,
	`settings` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `clients` DROP COLUMN `model_spend_ceiling`;