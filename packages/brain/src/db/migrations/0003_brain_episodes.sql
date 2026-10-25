CREATE TABLE `brain_capture_cursors` (
	`source` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `brain_episode_members` (
	`episode_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`episode_id`, `user_id`),
	FOREIGN KEY (`episode_id`) REFERENCES `brain_episodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `brain_episode_members_user_idx` ON `brain_episode_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `brain_episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_seq` integer NOT NULL,
	`owner_id` text NOT NULL,
	`scope` text NOT NULL,
	`audience` text,
	`task_type` text NOT NULL,
	`execution` text NOT NULL,
	`result` text NOT NULL,
	`evidence_id` text NOT NULL,
	`evidence_refs` text NOT NULL,
	`version_refs` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`recorded_at` integer NOT NULL,
	`delivery` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `brain_episodes_owner_idx` ON `brain_episodes` (`owner_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `brain_episodes_evidence_idx` ON `brain_episodes` (`evidence_id`);--> statement-breakpoint
CREATE TABLE `brain_erased_evidence` (
	`evidence_id` text PRIMARY KEY NOT NULL,
	`erased_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `brain_forgotten_people` (
	`user_id` text PRIMARY KEY NOT NULL,
	`forgotten_at` integer NOT NULL
);
