CREATE TABLE `memory_judging` (
	`id` integer PRIMARY KEY NOT NULL,
	`through` integer NOT NULL,
	`turn` text,
	CONSTRAINT "memory_judging_one" CHECK(id = 1)
);
--> statement-breakpoint
CREATE TABLE `memory_judging_places` (
	`source` text PRIMARY KEY NOT NULL,
	`version_row` integer NOT NULL,
	`after_version` integer NOT NULL,
	`after_row` integer NOT NULL,
	FOREIGN KEY (`source`) REFERENCES `current_versions`(`source`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `current_versions_unjudged_idx` ON `current_versions` (`source`) WHERE judged_row IS NOT version_row;