-- Workflows keep no stores (GRA-1552): only Apps own a store from here on.
-- What reached a workflow's store goes with it, while `sdk_store_owners`
-- still says which stores those are. Other workflows' operation bindings
-- of one are unresolved again, as revoking their approval leaves them
-- (workflow-bindings.ts), and the approvals revoked: nothing counts as the
-- store's consumer any more. Each statement changes nothing run again.
-- The tables and columns stay as they are for an older core still serving
-- (expand, then contract: GRA-1613), and the stores themselves are closed
-- on the clock, as a deletion closes one (data-stores.ts,
-- `closeFormerWorkflowStores`), audited and their records purged.
UPDATE `workflow_binding_approvals` SET `status` = 'revoked', `revoked_at` = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE `status` = 'active' AND `id` IN (SELECT `approval_id` FROM `sdk_resource_bindings` WHERE `kind` = 'operation' AND `target_id` IN (SELECT `store_id` FROM `sdk_store_owners` WHERE `workflow_id` IS NOT NULL));--> statement-breakpoint
UPDATE `sdk_resource_bindings` SET `target_id` = `contract_id`, `target_version` = NULL, `target_path` = NULL, `approval_id` = NULL WHERE `kind` = 'operation' AND `target_id` IN (SELECT `store_id` FROM `sdk_store_owners` WHERE `workflow_id` IS NOT NULL);--> statement-breakpoint
-- Grants on such a store: no App owns it, so nobody could revoke one.
DELETE FROM `permissions` WHERE `object_type` = 'store' AND `object_id` IN (SELECT `store_id` FROM `sdk_store_owners` WHERE `workflow_id` IS NOT NULL);--> statement-breakpoint
DELETE FROM `sdk_resource_bindings` WHERE `kind` = 'store' AND `resource_id` IN (SELECT `id` FROM `workflow_resources`);
