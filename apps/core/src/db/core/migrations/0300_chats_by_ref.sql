-- A chat is named by its ref, its workspace and its ID there, outside the
-- person's own object (chat-ref.ts). Expand only: the release before still
-- runs on this schema while this one rolls out, or after a rollback, so
-- nothing it writes or keys on goes (`chat_ids`, `stephen_requests.chat_id`
-- and the keys by a chat's ID alone stay until the contract migration).
-- The new keys sit beside the old ones; every row unique under an old key
-- is unique under its new one, which only adds the workspace.
ALTER TABLE `agent_wakes` ADD `workspace_id` text;--> statement-breakpoint
ALTER TABLE `chat_turns` ADD `workspace_id` text;--> statement-breakpoint
ALTER TABLE `draft_checkpoints` ADD `workspace_id` text;--> statement-breakpoint
CREATE INDEX `draft_checkpoints_chat_ref` ON `draft_checkpoints` (`workspace_id`,`chat_id`,`turn_id`);--> statement-breakpoint
ALTER TABLE `permissions` ADD `workspace_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `permissions_live_chat_ref_binding_idx` ON `permissions` (`workspace_id`,`chat_id`,`subject_type`,`subject_id`,`binding`) WHERE status <> 'revoked' AND chat_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_held_starts_ref_key` ON `agent_held_starts` (`workspace_id`,`chat_id`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_audiences_chat_ref_idx` ON `chat_audiences` (`workspace_id`,`chat_id`);--> statement-breakpoint
CREATE INDEX `chat_workflow_offers_chat_ref_idx` ON `chat_workflow_offers` (`workspace_id`,`chat_id`);--> statement-breakpoint
-- Each row a release before wrote takes its workspace from what it holds:
-- every person's chats are in their own object, `person:<their ID>`
-- (personal-workspace.ts), and a chat's permission, checkpoint and
-- wake-up name that person. `chat_turns` rows name no person: theirs stay
-- null, read by nothing.
UPDATE `permissions` SET `workspace_id` = 'person:' || `requested_by` WHERE `chat_id` IS NOT NULL AND `workspace_id` IS NULL;--> statement-breakpoint
UPDATE `draft_checkpoints` SET `workspace_id` = 'person:' || `person_id` WHERE `chat_id` IS NOT NULL AND `workspace_id` IS NULL;--> statement-breakpoint
UPDATE `agent_wakes` SET `workspace_id` = 'person:' || `person_id` WHERE `chat_id` IS NOT NULL AND `workspace_id` IS NULL;