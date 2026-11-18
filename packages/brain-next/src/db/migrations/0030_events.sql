CREATE TABLE `events` (
	`row` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`team` text NOT NULL,
	`step` text NOT NULL,
	`item` text,
	`who` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_key_team_idx` ON `events` (`key`,`team`);--> statement-breakpoint
CREATE INDEX `events_at_idx` ON `events` (`at`);--> statement-breakpoint
CREATE INDEX `events_who_idx` ON `events` (`who`);