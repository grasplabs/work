CREATE TABLE `api_budget` (
	`token` text PRIMARY KEY NOT NULL,
	`remaining` integer NOT NULL,
	`reset_at` integer NOT NULL,
	`blocked_until` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rollouts` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`release_id` text NOT NULL,
	`status` text NOT NULL,
	`started_by` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`halted_reason` text,
	`resumed_at` integer,
	`done` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rollouts_live_channel_idx` ON `rollouts` (`channel`) WHERE "rollouts"."status" in ('running', 'halted');--> statement-breakpoint
CREATE INDEX `rollouts_release_channel_idx` ON `rollouts` (`release_id`,`channel`);--> statement-breakpoint
ALTER TABLE `client_deploys` ADD `rollout_id` text REFERENCES rollouts(id);--> statement-breakpoint
ALTER TABLE `client_runs` ADD `step` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `clients` ADD `rollout_group` text DEFAULT 'normal' NOT NULL;