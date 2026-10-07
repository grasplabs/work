CREATE TABLE `audit_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`by` text NOT NULL,
	`what` text NOT NULL,
	`about` text
);
--> statement-breakpoint
CREATE TABLE `interview_states` (
	`person` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `links` (
	`person` text PRIMARY KEY NOT NULL,
	`sent_at` text NOT NULL,
	`opened_at` text,
	`reminded_at` text
);
--> statement-breakpoint
CREATE TABLE `onboarding` (
	`id` integer PRIMARY KEY NOT NULL,
	`plan` text,
	`agreements` text,
	`paused_at` text,
	CONSTRAINT "onboarding_one_row" CHECK("onboarding"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`team` text NOT NULL,
	`title` text NOT NULL,
	`away` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`lead` text,
	`does` text NOT NULL,
	`off` integer NOT NULL,
	`mapped_at` text
);
--> statement-breakpoint
CREATE TABLE `usage` (
	`day` text NOT NULL,
	`purpose` text NOT NULL,
	`model` text NOT NULL,
	`calls` integer NOT NULL,
	`tokens_in` integer NOT NULL,
	`tokens_cached` integer NOT NULL,
	`tokens_out` integer NOT NULL,
	`seconds` real NOT NULL,
	PRIMARY KEY(`day`, `purpose`, `model`)
);
