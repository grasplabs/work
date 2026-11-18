CREATE TABLE `proposal_sources` (
	`source` text NOT NULL,
	`proposal` text NOT NULL,
	PRIMARY KEY(`source`, `proposal`)
);
--> statement-breakpoint
CREATE INDEX `proposal_sources_proposal_idx` ON `proposal_sources` (`proposal`);--> statement-breakpoint
CREATE TABLE `skill_proposals` (
	`key` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`text` text,
	`rests_on` text,
	`drafted_at` integer NOT NULL
);
