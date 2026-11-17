CREATE TABLE `brain_drawings` (
	`source` text PRIMARY KEY NOT NULL,
	`record` text NOT NULL,
	`workflow` text NOT NULL,
	`team` text NOT NULL,
	`name` text NOT NULL,
	`local` text,
	`drawing` text NOT NULL,
	`at` text NOT NULL,
	`erase` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `brain_drawings_record` ON `brain_drawings` (`record`);--> statement-breakpoint
CREATE INDEX `brain_drawings_team` ON `brain_drawings` (`team`);