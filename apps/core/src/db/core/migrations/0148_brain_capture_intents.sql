CREATE TABLE `brain_capture_intents` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brain_capture_intents_event_idx` ON `brain_capture_intents` (`event_id`);--> statement-breakpoint
CREATE INDEX `brain_capture_intents_evidence_idx` ON `brain_capture_intents` (`evidence_id`);--> statement-breakpoint
CREATE INDEX `brain_capture_intents_state_idx` ON `brain_capture_intents` (`state`,`attempts`,`seq`);