CREATE TABLE `brain_opinions` (
	`source` text PRIMARY KEY NOT NULL,
	`record` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`at` text NOT NULL,
	`erase` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `brain_opinions_record` ON `brain_opinions` (`record`);--> statement-breakpoint
CREATE TABLE `opinion_backers` (
	`record` text NOT NULL,
	`person` text NOT NULL,
	PRIMARY KEY(`record`, `person`)
);
--> statement-breakpoint
CREATE INDEX `opinion_backers_person` ON `opinion_backers` (`person`);--> statement-breakpoint
CREATE TABLE `opinion_candidates` (
	`id` text NOT NULL,
	`team` text NOT NULL,
	`text` text NOT NULL,
	`person` text NOT NULL,
	PRIMARY KEY(`id`, `person`)
);
--> statement-breakpoint
CREATE INDEX `opinion_candidates_team` ON `opinion_candidates` (`team`);--> statement-breakpoint
CREATE INDEX `opinion_candidates_person` ON `opinion_candidates` (`person`);--> statement-breakpoint
CREATE TABLE `opinion_inputs` (
	`key` text PRIMARY KEY NOT NULL,
	`input` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `opinion_people` (
	`person` text PRIMARY KEY NOT NULL,
	`merged_from` text,
	`run_from` text
);
