CREATE TABLE `referrals` (
	`person` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `events` ADD `named` text;