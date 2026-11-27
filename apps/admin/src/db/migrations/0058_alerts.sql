CREATE TABLE `alert_channels` (
	`channel` text PRIMARY KEY NOT NULL,
	`on` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alerts` (
	`key` text PRIMARY KEY NOT NULL,
	`failing` integer NOT NULL,
	`event` text NOT NULL,
	`changed_at` integer NOT NULL,
	`pending` text NOT NULL,
	`attempts` integer NOT NULL,
	`told` text NOT NULL
);
