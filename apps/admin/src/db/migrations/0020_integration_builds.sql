CREATE TABLE `integration_builds` (
	`app` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`stage` text NOT NULL,
	`stopped_at` text,
	`reason` text,
	`run_id` text NOT NULL,
	`plan` text,
	`plan_round` integer DEFAULT 0 NOT NULL,
	`plan_note` text,
	`approved_by` text,
	`branch` text,
	`pull_request` integer,
	`merge_commit_sha` text,
	`requested_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
