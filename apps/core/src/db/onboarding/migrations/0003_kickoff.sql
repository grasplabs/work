CREATE TABLE `kickoff` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`by` text NOT NULL,
	`file_name` text,
	`transcript` text NOT NULL,
	`reading` text NOT NULL,
	`answers` text DEFAULT '{}' NOT NULL,
	CONSTRAINT "kickoff_one_row" CHECK("kickoff"."id" = 1)
);
