ALTER TABLE `trigger_resource_versions` ADD `event_contract` text;--> statement-breakpoint
ALTER TABLE `trigger_resource_versions` ADD `event_type` text;--> statement-breakpoint
CREATE INDEX `trigger_resource_versions_event` ON `trigger_resource_versions` (`event_contract`,`event_type`) WHERE "trigger_resource_versions"."event_contract" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_emitted_events` ADD `delivery_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_emitted_events` ADD `delivery_at` integer;--> statement-breakpoint
ALTER TABLE `workflow_emitted_events` ADD `undeliverable` text;--> statement-breakpoint
-- An emitted event's delivery is settled once: once `delivered_at` is
-- set, why it was undeliverable (`undeliverable`) never changes either
-- (workflows/event-delivery.ts). Its attempts and lease change freely.
DROP TRIGGER `workflow_emitted_events_immutable_update`;
--> statement-breakpoint
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
	AND (NEW.`undeliverable` IS OLD.`undeliverable` OR OLD.`delivered_at` IS NULL)
	AND (
		(NEW.`subject` IS OLD.`subject` AND NEW.`data` IS OLD.`data`
			AND NEW.`details_removed_at` IS OLD.`details_removed_at`)
		OR (OLD.`details_removed_at` IS NULL AND NEW.`details_removed_at` IS NOT NULL
			AND NEW.`subject` IS NULL AND NEW.`data` IS NULL)
	)
) BEGIN
	SELECT RAISE(ABORT, 'workflow_emitted_events are immutable');
END;
