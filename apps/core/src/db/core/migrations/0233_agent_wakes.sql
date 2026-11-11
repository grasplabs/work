CREATE TABLE `agent_wakes` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`cron` text NOT NULL,
	`time_zone` text NOT NULL,
	`person_id` text NOT NULL,
	`opening` text NOT NULL,
	`state` text NOT NULL,
	`next_at` integer,
	`retry_at` integer,
	`chat_id` text,
	`last_at` integer,
	`last_outcome` text,
	`made_by` text NOT NULL,
	`made_at` integer NOT NULL,
	`changed_by` text NOT NULL,
	`changed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_wakes_agent_idx` ON `agent_wakes` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_wakes_person_idx` ON `agent_wakes` (`person_id`);--> statement-breakpoint
CREATE INDEX `agent_wakes_next_idx` ON `agent_wakes` (`next_at`) WHERE "agent_wakes"."next_at" IS NOT NULL;