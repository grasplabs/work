CREATE TABLE `workflow_emitted_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`workflow_resource_id` text NOT NULL,
	`version` integer NOT NULL,
	`task_id` text NOT NULL,
	`binding` text NOT NULL,
	`contract_id` text NOT NULL,
	`source` text NOT NULL,
	`type` text NOT NULL,
	`subject` text,
	`dataschema` text,
	`data` text,
	`restricted` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	`details_removed_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_resource_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_emitted_events_run` ON `workflow_emitted_events` (`run_id`);--> statement-breakpoint
CREATE INDEX `workflow_emitted_events_undelivered` ON `workflow_emitted_events` (`created_at`) WHERE "workflow_emitted_events"."delivered_at" IS NULL;
--> statement-breakpoint
-- An emitted event is written once: its ID, run, binding, contract and
-- envelope never change. Only its delivery is marked, once, and retention
-- removes its subject and data, once (workflows/emitted-events.ts).
CREATE TRIGGER `workflow_emitted_events_immutable_update` BEFORE UPDATE ON `workflow_emitted_events`
WHEN NOT (
	NEW.`id` IS OLD.`id`
	AND NEW.`run_id` IS OLD.`run_id`
	AND NEW.`workflow_resource_id` IS OLD.`workflow_resource_id`
	AND NEW.`version` IS OLD.`version`
	AND NEW.`task_id` IS OLD.`task_id`
	AND NEW.`binding` IS OLD.`binding`
	AND NEW.`contract_id` IS OLD.`contract_id`
	AND NEW.`source` IS OLD.`source`
	AND NEW.`type` IS OLD.`type`
	AND NEW.`dataschema` IS OLD.`dataschema`
	AND NEW.`restricted` IS OLD.`restricted`
	AND NEW.`created_at` IS OLD.`created_at`
	AND (NEW.`delivered_at` IS OLD.`delivered_at` OR OLD.`delivered_at` IS NULL)
	AND (
		(NEW.`subject` IS OLD.`subject` AND NEW.`data` IS OLD.`data`
			AND NEW.`details_removed_at` IS OLD.`details_removed_at`)
		OR (OLD.`details_removed_at` IS NULL AND NEW.`details_removed_at` IS NOT NULL
			AND NEW.`subject` IS NULL AND NEW.`data` IS NULL)
	)
) BEGIN
	SELECT RAISE(ABORT, 'workflow_emitted_events are immutable');
END;
