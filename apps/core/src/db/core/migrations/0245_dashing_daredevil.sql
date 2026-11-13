CREATE TABLE `brain_restores` (
	`export_id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`reopened_at` integer
);
--> statement-breakpoint
CREATE TABLE `skill_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`seq` integer NOT NULL,
	`share_id` text,
	`text` text NOT NULL,
	`decided_by` text,
	`decided_at` integer NOT NULL,
	`outcome` text,
	`version` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_decisions_seq_idx` ON `skill_decisions` (`name`,`seq`);--> statement-breakpoint
CREATE INDEX `skill_decisions_share_idx` ON `skill_decisions` (`share_id`);--> statement-breakpoint
CREATE INDEX `skill_decisions_open_idx` ON `skill_decisions` (`name`) WHERE outcome IS NULL;--> statement-breakpoint
CREATE TABLE `skill_deletions` (
	`person_id` text NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`person_id`, `name`)
);
--> statement-breakpoint
CREATE TABLE `skill_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`text` text,
	`requested_by` text NOT NULL,
	`requested_at` integer NOT NULL,
	`status` text NOT NULL,
	`decided_by` text,
	`decided_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_shares_pending_idx` ON `skill_shares` (`requested_by`,`name`) WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX `skill_shares_status_idx` ON `skill_shares` (`status`,`requested_at`);