CREATE TABLE `approvals` (
	`person` text NOT NULL,
	`fact` text NOT NULL,
	`revision` text NOT NULL,
	`receipt` text NOT NULL,
	`at` text NOT NULL,
	PRIMARY KEY(`person`, `fact`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `forget_lines` (
	`key` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `participations` (
	`person` text PRIMARY KEY NOT NULL,
	`notice` integer NOT NULL,
	`purpose` text NOT NULL,
	`audience` text NOT NULL,
	`at` text NOT NULL,
	`withdrawn_at` text
);
--> statement-breakpoint
CREATE TABLE `readbacks` (
	`person` text NOT NULL,
	`receipt` text NOT NULL,
	`at` text NOT NULL,
	PRIMARY KEY(`person`, `receipt`)
);
--> statement-breakpoint
ALTER TABLE `interview_states` ADD `revoked_at` text;--> statement-breakpoint
ALTER TABLE `interviews` ADD `revisions` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `teams` ADD `mapped_from` text;