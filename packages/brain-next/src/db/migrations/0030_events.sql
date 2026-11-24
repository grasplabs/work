CREATE TABLE `closed_event_tags` (
	`who` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `closed_event_tags_at_idx` ON `closed_event_tags` (`at`);--> statement-breakpoint
CREATE TABLE `event_key` (
	`row` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	CONSTRAINT "event_key_one_row" CHECK("event_key"."row" = 1)
);
--> statement-breakpoint
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