CREATE TABLE `checked_differences` (
	`work` text PRIMARY KEY NOT NULL,
	`drawn_at` text NOT NULL,
	`way` text NOT NULL,
	`other` text NOT NULL,
	`at` text NOT NULL
);--> statement-breakpoint
-- GRA-1084: the review shows a difference only once an intake checked it
-- here, and teams the brain already has wait for nothing new. Every team
-- given before is given again, so its differences are checked; none is
-- marked checked here.
UPDATE `brain_teams` SET `due_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `sent_at` IS NOT NULL AND `due_at` IS NULL;
