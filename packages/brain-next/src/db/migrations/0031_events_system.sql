-- Events gain their system and whether they wrote (GRA-1764). SQLite can't
-- add a column NOT NULL without a default, and an event kept before has
-- neither: events are short-lived (90 days) and nothing is released, so
-- the table starts again empty.
DROP TABLE `events`;--> statement-breakpoint
CREATE TABLE `events` (
	`row` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`team` text NOT NULL,
	`step` text NOT NULL,
	`system` text NOT NULL,
	`writes` integer NOT NULL,
	`item` text,
	`who` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_key_team_idx` ON `events` (`key`,`team`);--> statement-breakpoint
CREATE INDEX `events_at_idx` ON `events` (`at`);--> statement-breakpoint
CREATE INDEX `events_who_idx` ON `events` (`who`);--> statement-breakpoint
CREATE INDEX `events_trail_idx` ON `events` (`team`,`who`,`at`,`row`);
