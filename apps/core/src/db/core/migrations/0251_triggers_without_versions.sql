PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_held_starts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`person_id` text NOT NULL,
	`workflow_resource_id` text NOT NULL,
	`workflow_resource_version` integer,
	`input` text,
	`input_hash` text NOT NULL,
	`key` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decision` text,
	`decided_at` integer,
	`start_id` text,
	`refusal` text,
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_agent_held_starts`("id", "workspace_id", "chat_id", "agent_id", "person_id", "workflow_resource_id", "workflow_resource_version", "input", "input_hash", "key", "created_at", "expires_at", "decision", "decided_at", "start_id", "refusal") SELECT "id", "workspace_id", "chat_id", "agent_id", "person_id", "workflow_resource_id", "workflow_resource_version", "input", "input_hash", "key", "created_at", "expires_at", "decision", "decided_at", "start_id", "refusal" FROM `agent_held_starts`;--> statement-breakpoint
DROP TABLE `agent_held_starts`;--> statement-breakpoint
ALTER TABLE `__new_agent_held_starts` RENAME TO `agent_held_starts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_held_starts_key` ON `agent_held_starts` (`chat_id`,`key`);--> statement-breakpoint
CREATE INDEX `agent_held_starts_person` ON `agent_held_starts` (`person_id`,`created_at`) WHERE "agent_held_starts"."decision" IS NULL;--> statement-breakpoint
CREATE INDEX `agent_held_starts_kept` ON `agent_held_starts` (`expires_at`) WHERE "agent_held_starts"."input" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_chat_workflow_offers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`workflow_name` text NOT NULL,
	`version` integer,
	`input` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`posted_at` integer,
	`platform` text,
	`thread_id` text,
	`locale` text,
	`pressed_at` integer,
	`start_id` text,
	`run_id` text,
	`told_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_chat_workflow_offers`("id", "user_id", "workspace_id", "chat_id", "workflow_id", "workflow_name", "version", "input", "created_at", "expires_at", "posted_at", "platform", "thread_id", "locale", "pressed_at", "start_id", "run_id", "told_at") SELECT "id", "user_id", "workspace_id", "chat_id", "workflow_id", "workflow_name", "version", "input", "created_at", "expires_at", "posted_at", "platform", "thread_id", "locale", "pressed_at", "start_id", "run_id", "told_at" FROM `chat_workflow_offers`;--> statement-breakpoint
DROP TABLE `chat_workflow_offers`;--> statement-breakpoint
ALTER TABLE `__new_chat_workflow_offers` RENAME TO `chat_workflow_offers`;--> statement-breakpoint
CREATE INDEX `chat_workflow_offers_chat_idx` ON `chat_workflow_offers` (`chat_id`);--> statement-breakpoint
CREATE INDEX `chat_workflow_offers_run_idx` ON `chat_workflow_offers` (`run_id`);--> statement-breakpoint
CREATE INDEX `chat_workflow_offers_user_idx` ON `chat_workflow_offers` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_trigger_schedules` (
	`trigger_id` text PRIMARY KEY NOT NULL,
	`version` integer,
	`next_at` integer,
	`failed_starts` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer,
	FOREIGN KEY (`trigger_id`) REFERENCES `trigger_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_trigger_schedules`("trigger_id", "version", "next_at", "failed_starts", "attempts", "last_attempt_at") SELECT "trigger_id", "version", "next_at", "failed_starts", "attempts", "last_attempt_at" FROM `trigger_schedules`;--> statement-breakpoint
DROP TABLE `trigger_schedules`;--> statement-breakpoint
ALTER TABLE `__new_trigger_schedules` RENAME TO `trigger_schedules`;--> statement-breakpoint
CREATE INDEX `trigger_schedules_next_at` ON `trigger_schedules` (`next_at`) WHERE "trigger_schedules"."next_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `trigger_resources` ADD `workflow_resource_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `trigger_resources` ADD `config_hash` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `trigger_resources` ADD `principal_binding` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `trigger_resources` ADD `event_type` text;--> statement-breakpoint
ALTER TABLE `trigger_resources` ADD `schedule_cron` text;--> statement-breakpoint
ALTER TABLE `trigger_resources` ADD `schedule_time_zone` text;--> statement-breakpoint
ALTER TABLE `trigger_resources` ADD `schedule_input` text;--> statement-breakpoint
ALTER TABLE `trigger_resources` ADD `connection_id` text;--> statement-breakpoint
ALTER TABLE `trigger_resources` ADD `connection_resource` text;--> statement-breakpoint
ALTER TABLE `trigger_resources` ADD `input_mapping` text;--> statement-breakpoint
ALTER TABLE `trigger_resources` ADD `event_source_id` text;--> statement-breakpoint
-- A trigger has no versions: each keeps its configuration on its own row,
-- copied from the version it ran (`current_version`), and
-- `trigger_resource_versions` is used no more (src/trigger-resources.ts).
UPDATE `trigger_resources` SET (`workflow_resource_id`, `config_hash`, `principal_binding`, `event_type`, `schedule_cron`, `schedule_time_zone`, `schedule_input`, `connection_id`, `connection_resource`, `input_mapping`, `event_source_id`) = (
  SELECT `workflow_resource_id`, `config_hash`, `principal_binding`, `event_type`, `schedule_cron`, `schedule_time_zone`, `schedule_input`, `connection_id`, `connection_resource`, `input_mapping`, `event_source_id`
  FROM `trigger_resource_versions` AS `current`
  WHERE `current`.`trigger_id` = `trigger_resources`.`id` AND `current`.`version` = `trigger_resources`.`current_version`)
WHERE EXISTS (SELECT 1 FROM `trigger_resource_versions` AS `current`
  WHERE `current`.`trigger_id` = `trigger_resources`.`id` AND `current`.`version` = `trigger_resources`.`current_version`);--> statement-breakpoint
CREATE INDEX `trigger_resources_source` ON `trigger_resources` (`event_source_id`,`event_type`) WHERE "trigger_resources"."event_source_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `trigger_resources_connection` ON `trigger_resources` (`connection_id`,`event_type`) WHERE "trigger_resources"."connection_id" IS NOT NULL;