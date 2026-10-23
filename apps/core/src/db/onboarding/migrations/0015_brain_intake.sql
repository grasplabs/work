CREATE TABLE `brain_sent` (
	`record` text NOT NULL,
	`type` text NOT NULL,
	`team` text NOT NULL,
	`person` text NOT NULL,
	PRIMARY KEY(`record`, `person`)
);
--> statement-breakpoint
CREATE INDEX `brain_sent_person` ON `brain_sent` (`person`);--> statement-breakpoint
CREATE TABLE `brain_teams` (
	`team` text PRIMARY KEY NOT NULL,
	`due_at` text,
	`sent_at` text
);
