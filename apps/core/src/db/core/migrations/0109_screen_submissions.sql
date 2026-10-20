CREATE TABLE `screen_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`app_id` text NOT NULL,
	`kind` text NOT NULL,
	`contract_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`app_version` integer NOT NULL,
	`path` text NOT NULL,
	`store_id` text,
	`store_contract_id` text,
	`failed_category` text,
	`failed_fence` integer,
	`attempt` integer DEFAULT 1 NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "screen_submissions_kind" CHECK("screen_submissions"."kind" IN ('mutation', 'action'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `screen_submissions_key` ON `screen_submissions` (`person_id`,`app_id`,`kind`,`contract_id`,`fingerprint`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `screen_submissions_person` ON `screen_submissions` (`person_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `screen_submissions_expires_at` ON `screen_submissions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `screen_submissions_app` ON `screen_submissions` (`person_id`,`app_id`);