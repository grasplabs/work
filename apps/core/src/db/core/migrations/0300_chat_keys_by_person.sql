-- A chat's own permissions and held starts are unique by whose chat it is
-- as well as its ID: a page names a chat's ID (#2836), so the ID alone is
-- no one person's. Each index only gains a column: rows unique under the
-- old key are unique under the new one, so it builds on any table.
DROP INDEX `agent_held_starts_key`;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_held_starts_key` ON `agent_held_starts` (`workspace_id`,`chat_id`,`key`);--> statement-breakpoint
DROP INDEX `permissions_live_chat_binding_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `permissions_live_chat_binding_idx` ON `permissions` (`chat_id`,`requested_by`,`subject_type`,`subject_id`,`binding`) WHERE status <> 'revoked' AND chat_id IS NOT NULL;