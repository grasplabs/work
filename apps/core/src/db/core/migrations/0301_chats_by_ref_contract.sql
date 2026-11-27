-- The contract of 0300 (expand, then contract): since 26.11.889 (#2845)
-- no release takes chat IDs in `chat_ids`, writes
-- `stephen_requests.chat_id` or writes a chat's row with no workspace, or
-- half a chat's ref. What only the releases before used goes: `chat_ids`,
-- `stephen_requests.chat_id` and the keys by a chat's ID alone. A chat's
-- ref is whole or absent (CHECK), and a turn's record always names its
-- workspace: one a release before 26.11.889 wrote names none, nor its
-- person, and goes.
-- `chat_audiences` keeps its key by the chat's ID for a release more: the
-- release before upserts on it.
-- contract: drop table chat_ids: release 26.11.889 removed the last use
-- contract: drop column stephen_requests.chat_id: release 26.11.889 removed the last use
-- contract: add check permissions: release 26.11.889 removed the last use
-- contract: add check draft_checkpoints: release 26.11.889 removed the last use
-- contract: add check agent_wakes: release 26.11.889 removed the last use
-- contract: make not null chat_turns.workspace_id: release 26.11.889 removed the last use
-- contract: delete rows chat_turns: release 26.11.889 removed the last use
-- contract: change values __new_chat_turns: release 26.11.889 removed the last use
DROP TABLE `chat_ids`;--> statement-breakpoint
DROP INDEX `agent_held_starts_key`;--> statement-breakpoint
DROP INDEX `chat_workflow_offers_chat_idx`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_draft_checkpoints` (
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`number` integer NOT NULL,
	`revision` integer NOT NULL,
	`base` integer,
	`definition` text,
	`content_hash` text NOT NULL,
	`person_id` text NOT NULL,
	`workspace_id` text,
	`chat_id` text,
	`turn_id` text,
	`call_id` text,
	`restored_from` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`subject_kind`, `subject_id`, `number`),
	CONSTRAINT "draft_checkpoints_whole_chat" CHECK((workspace_id IS NULL) = (chat_id IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_draft_checkpoints`("subject_kind", "subject_id", "number", "revision", "base", "definition", "content_hash", "person_id", "workspace_id", "chat_id", "turn_id", "call_id", "restored_from", "created_at") SELECT "subject_kind", "subject_id", "number", "revision", "base", "definition", "content_hash", "person_id", "workspace_id", "chat_id", "turn_id", "call_id", "restored_from", "created_at" FROM `draft_checkpoints`;--> statement-breakpoint
DROP TABLE `draft_checkpoints`;--> statement-breakpoint
ALTER TABLE `__new_draft_checkpoints` RENAME TO `draft_checkpoints`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `draft_checkpoints_chat_ref` ON `draft_checkpoints` (`workspace_id`,`chat_id`,`turn_id`);--> statement-breakpoint
-- Its trigger went with the table it was on (migration 0250).
CREATE TRIGGER `draft_checkpoints_removed_app_insert` BEFORE INSERT ON `draft_checkpoints`
WHEN NEW.`subject_kind` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`subject_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'draft_checkpoints: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TABLE `__new_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`object_type` text NOT NULL,
	`object_id` text NOT NULL,
	`resource` text,
	`actions` text NOT NULL,
	`binding` text NOT NULL,
	`status` text NOT NULL,
	`requested_by` text NOT NULL,
	`requested_at` integer NOT NULL,
	`granted_by` text,
	`granted_at` integer,
	`revoked_by` text,
	`revoked_at` integer,
	`requested_via` text,
	`workspace_id` text,
	`chat_id` text,
	`reason` text,
	`personal` integer DEFAULT false NOT NULL,
	`teams` text,
	CONSTRAINT "permissions_whole_chat" CHECK((workspace_id IS NULL) = (chat_id IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_permissions`("id", "subject_type", "subject_id", "object_type", "object_id", "resource", "actions", "binding", "status", "requested_by", "requested_at", "granted_by", "granted_at", "revoked_by", "revoked_at", "requested_via", "workspace_id", "chat_id", "reason", "personal", "teams") SELECT "id", "subject_type", "subject_id", "object_type", "object_id", "resource", "actions", "binding", "status", "requested_by", "requested_at", "granted_by", "granted_at", "revoked_by", "revoked_at", "requested_via", "workspace_id", "chat_id", "reason", "personal", "teams" FROM `permissions`;--> statement-breakpoint
DROP TABLE `permissions`;--> statement-breakpoint
ALTER TABLE `__new_permissions` RENAME TO `permissions`;--> statement-breakpoint
CREATE INDEX `permissions_subject_idx` ON `permissions` (`subject_type`,`subject_id`,`status`);--> statement-breakpoint
CREATE INDEX `permissions_revoked_idx` ON `permissions` (`subject_type`,`subject_id`,`status`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `permissions_object_idx` ON `permissions` (`object_type`,`object_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `permissions_live_binding_idx` ON `permissions` (`subject_type`,`subject_id`,`binding`) WHERE status <> 'revoked' AND chat_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `permissions_live_chat_ref_binding_idx` ON `permissions` (`workspace_id`,`chat_id`,`subject_type`,`subject_id`,`binding`) WHERE status <> 'revoked' AND chat_id IS NOT NULL;--> statement-breakpoint
-- Its triggers went with the table they were on (migration 0170).
CREATE TRIGGER `permissions_removed_app_insert` BEFORE INSERT ON `permissions`
WHEN (NEW.`subject_type` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`subject_id` AND `removed_at` IS NOT NULL))
	OR (NEW.`object_type` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`object_id` AND `removed_at` IS NOT NULL))
BEGIN
	SELECT RAISE(ABORT, 'permissions: takes nothing new for a removed App');
END;
--> statement-breakpoint
-- Only towards revoked.
CREATE TRIGGER `permissions_removed_app_update` BEFORE UPDATE ON `permissions`
WHEN NEW.`status` <> 'revoked' AND (
	(NEW.`subject_type` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`subject_id` AND `removed_at` IS NOT NULL))
	OR (NEW.`object_type` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`object_id` AND `removed_at` IS NOT NULL))
)
BEGIN
	SELECT RAISE(ABORT, 'permissions: takes nothing new for a removed App');
END;
--> statement-breakpoint
DROP INDEX `stephen_requests_person_idx`;--> statement-breakpoint
CREATE INDEX `stephen_requests_person_idx` ON `stephen_requests` (`person_id`);--> statement-breakpoint
ALTER TABLE `stephen_requests` DROP COLUMN `chat_id`;--> statement-breakpoint
CREATE TABLE `__new_chat_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`surface` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`sent_at` integer NOT NULL,
	`first_request_ms` integer,
	`first_token_ms` integer,
	`first_text_ms` integer,
	`done_ms` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`cost` real NOT NULL,
	`tools` text NOT NULL,
	`retries` integer NOT NULL,
	`fallbacks` integer NOT NULL,
	`rate_limit_waits` integer NOT NULL,
	`rate_limit_wait_ms` integer NOT NULL,
	`stop_reason` text,
	`outcome` text NOT NULL,
	`code` text,
	`compacted` integer NOT NULL,
	`queued` integer DEFAULT 0 NOT NULL,
	`resumed` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_chat_turns`("id", "workspace_id", "chat_id", "surface", "model", "effort", "sent_at", "first_request_ms", "first_token_ms", "first_text_ms", "done_ms", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost", "tools", "retries", "fallbacks", "rate_limit_waits", "rate_limit_wait_ms", "stop_reason", "outcome", "code", "compacted", "queued", "resumed") SELECT "id", "workspace_id", "chat_id", "surface", "model", "effort", "sent_at", "first_request_ms", "first_token_ms", "first_text_ms", "done_ms", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost", "tools", "retries", "fallbacks", "rate_limit_waits", "rate_limit_wait_ms", "stop_reason", "outcome", "code", "compacted", "queued", "resumed" FROM `chat_turns` WHERE "workspace_id" IS NOT NULL;--> statement-breakpoint
DROP TABLE `chat_turns`;--> statement-breakpoint
ALTER TABLE `__new_chat_turns` RENAME TO `chat_turns`;--> statement-breakpoint
CREATE INDEX `chat_turns_sent_idx` ON `chat_turns` (`sent_at`);--> statement-breakpoint
CREATE TABLE `__new_agent_wakes` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`cron` text NOT NULL,
	`time_zone` text NOT NULL,
	`person_id` text NOT NULL,
	`opening` text NOT NULL,
	`state` text NOT NULL,
	`next_at` integer,
	`retry_at` integer,
	`workspace_id` text,
	`chat_id` text,
	`last_at` integer,
	`last_outcome` text,
	`made_by` text NOT NULL,
	`made_at` integer NOT NULL,
	`changed_by` text NOT NULL,
	`changed_at` integer NOT NULL,
	CONSTRAINT "agent_wakes_whole_chat" CHECK((workspace_id IS NULL) = (chat_id IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_agent_wakes`("id", "agent_id", "cron", "time_zone", "person_id", "opening", "state", "next_at", "retry_at", "workspace_id", "chat_id", "last_at", "last_outcome", "made_by", "made_at", "changed_by", "changed_at") SELECT "id", "agent_id", "cron", "time_zone", "person_id", "opening", "state", "next_at", "retry_at", "workspace_id", "chat_id", "last_at", "last_outcome", "made_by", "made_at", "changed_by", "changed_at" FROM `agent_wakes`;--> statement-breakpoint
DROP TABLE `agent_wakes`;--> statement-breakpoint
ALTER TABLE `__new_agent_wakes` RENAME TO `agent_wakes`;--> statement-breakpoint
CREATE INDEX `agent_wakes_agent_idx` ON `agent_wakes` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_wakes_person_idx` ON `agent_wakes` (`person_id`);--> statement-breakpoint
CREATE INDEX `agent_wakes_next_idx` ON `agent_wakes` (`next_at`) WHERE "agent_wakes"."next_at" IS NOT NULL;