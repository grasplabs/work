CREATE TABLE `skill_proposals` (
	`key` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`text` text,
	`rests_on` text,
	`drafted_at` integer NOT NULL
);
