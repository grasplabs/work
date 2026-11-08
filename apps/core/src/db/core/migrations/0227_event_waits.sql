CREATE TABLE `event_waits` (
	`run_id` text NOT NULL,
	`step` text NOT NULL,
	`event_type` text NOT NULL,
	`workflow_id` text NOT NULL,
	`binding` text NOT NULL,
	`source_id` text NOT NULL,
	`match_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `step`, `event_type`)
);
--> statement-breakpoint
CREATE INDEX `event_waits_match` ON `event_waits` (`source_id`,`event_type`,`match_hash`);--> statement-breakpoint
CREATE TABLE `kept_event_keys` (
	`event_id` text NOT NULL,
	`match_hash` text NOT NULL,
	PRIMARY KEY(`event_id`, `match_hash`)
);
--> statement-breakpoint
CREATE INDEX `kept_event_keys_match` ON `kept_event_keys` (`match_hash`);--> statement-breakpoint
CREATE TABLE `kept_events` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`event_type` text NOT NULL,
	`data` text,
	`received_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`taken_run` text,
	`taken_step` text,
	`taken_at` integer
);
--> statement-breakpoint
CREATE INDEX `kept_events_source` ON `kept_events` (`source_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `kept_events_expires` ON `kept_events` (`expires_at`);--> statement-breakpoint
CREATE INDEX `kept_events_taken` ON `kept_events` (`taken_run`,`taken_step`);