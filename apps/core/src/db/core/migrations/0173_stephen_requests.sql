CREATE TABLE `stephen_request_needs` (
	`key` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`status_by` text NOT NULL,
	`status_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stephen_request_proposals` (
	`key` text NOT NULL,
	`locale` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`key`, `locale`)
);
--> statement-breakpoint
CREATE TABLE `stephen_request_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_id` text NOT NULL,
	`wording` text NOT NULL,
	`role` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stephen_request_questions_topic_idx` ON `stephen_request_questions` (`topic_id`);--> statement-breakpoint
CREATE TABLE `stephen_request_topics` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stephen_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`place` text NOT NULL,
	`person_id` text NOT NULL,
	`team_id` text,
	`chat_id` text,
	`kind` text NOT NULL,
	`outcome` text NOT NULL,
	`topic_id` text,
	`question_id` text,
	`tools` text NOT NULL,
	`missing` text NOT NULL,
	`rating` text
);
--> statement-breakpoint
CREATE INDEX `stephen_requests_day_idx` ON `stephen_requests` (`day`);--> statement-breakpoint
CREATE INDEX `stephen_requests_person_idx` ON `stephen_requests` (`person_id`,`chat_id`);--> statement-breakpoint
CREATE INDEX `stephen_requests_question_idx` ON `stephen_requests` (`question_id`);--> statement-breakpoint
CREATE TABLE `stephen_summaries` (
	`week` text NOT NULL,
	`person_id` text NOT NULL,
	`via` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`reason` text,
	`queued_at` integer NOT NULL,
	`settled_at` integer,
	PRIMARY KEY(`week`, `person_id`)
);
--> statement-breakpoint
CREATE TABLE `stephen_summary_readers` (
	`person_id` text PRIMARY KEY NOT NULL,
	`via` text NOT NULL,
	`updated_at` integer NOT NULL
);
