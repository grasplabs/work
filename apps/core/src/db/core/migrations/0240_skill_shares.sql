CREATE TABLE `skill_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`text` text,
	`requested_by` text NOT NULL,
	`requested_at` integer NOT NULL,
	`status` text NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`version` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_shares_pending_idx` ON `skill_shares` (`requested_by`,`name`) WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX `skill_shares_status_idx` ON `skill_shares` (`status`,`requested_at`);