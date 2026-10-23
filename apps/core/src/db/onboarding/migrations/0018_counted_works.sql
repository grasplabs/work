CREATE TABLE `counted_works` (
	`work` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`by` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `onboarding` ADD `rules` text;