CREATE TABLE `brain_consolidation_due` (
	`scope_key` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`since` integer NOT NULL,
	`touched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `brain_consolidation_due_since_idx` ON `brain_consolidation_due` (`since`);--> statement-breakpoint
CREATE TABLE `brain_consolidation_marks` (
	`scope_key` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `brain_lesson_evidence` (
	`lesson_id` text NOT NULL,
	`revision` integer NOT NULL,
	`episode_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`lesson_id`, `revision`, `episode_id`),
	FOREIGN KEY (`episode_id`) REFERENCES `brain_episodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lesson_id`,`revision`) REFERENCES `brain_lesson_versions`(`lesson_id`,`revision`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `brain_lesson_evidence_episode_idx` ON `brain_lesson_evidence` (`episode_id`);--> statement-breakpoint
CREATE TABLE `brain_lesson_versions` (
	`lesson_id` text NOT NULL,
	`revision` integer NOT NULL,
	`supersedes` integer,
	`content` text NOT NULL,
	`patch_key` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`lesson_id`, `revision`),
	FOREIGN KEY (`lesson_id`) REFERENCES `brain_lessons`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brain_lesson_versions_patch_idx` ON `brain_lesson_versions` (`patch_key`);--> statement-breakpoint
CREATE TABLE `brain_lessons` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`group_key` text NOT NULL,
	`kind` text NOT NULL,
	`applicability` text NOT NULL,
	`exclusions` text NOT NULL,
	`instruction` text NOT NULL,
	`evidence_status` text NOT NULL,
	`state` text NOT NULL,
	`retired_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brain_lessons_group_idx` ON `brain_lessons` (`scope`,`scope_id`,`group_key`);--> statement-breakpoint
CREATE TABLE `brain_sequences` (
	`name` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `brain_episodes` ADD `seq` integer;--> statement-breakpoint
CREATE INDEX `brain_episodes_person_seq_idx` ON `brain_episodes` (`scope`,`owner_id`,`seq`);--> statement-breakpoint
CREATE INDEX `brain_episodes_session_seq_idx` ON `brain_episodes` (`scope`,`audience`,`seq`);