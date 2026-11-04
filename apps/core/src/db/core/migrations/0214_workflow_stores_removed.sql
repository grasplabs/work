-- Workflows keep no stores (GRA-1552): only Apps own a store from here on.
-- What reached a workflow's store goes with it first, while
-- `sdk_store_owners` still says which stores those are. Other workflows'
-- operation bindings of one are unresolved again, as revoking their
-- approval leaves them (workflow-bindings.ts), and the approvals revoked:
-- nothing counts as the store's consumer any more.
UPDATE `workflow_binding_approvals` SET `status` = 'revoked', `revoked_at` = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE `status` = 'active' AND `id` IN (SELECT `approval_id` FROM `sdk_resource_bindings` WHERE `kind` = 'operation' AND `target_id` IN (SELECT `store_id` FROM `sdk_store_owners` WHERE `workflow_id` IS NOT NULL));--> statement-breakpoint
UPDATE `sdk_resource_bindings` SET `target_id` = `contract_id`, `target_version` = NULL, `target_path` = NULL, `approval_id` = NULL WHERE `kind` = 'operation' AND `target_id` IN (SELECT `store_id` FROM `sdk_store_owners` WHERE `workflow_id` IS NOT NULL);--> statement-breakpoint
-- Grants on such a store: no App owns it, so nobody could revoke one.
DELETE FROM `permissions` WHERE `object_type` = 'store' AND `object_id` IN (SELECT `store_id` FROM `sdk_store_owners` WHERE `workflow_id` IS NOT NULL);--> statement-breakpoint
DELETE FROM `sdk_resource_bindings` WHERE `kind` = 'store' AND `resource_id` IN (SELECT `id` FROM `workflow_resources`);--> statement-breakpoint
-- The stores themselves are deleted, never left to whoever published the
-- workflow to manage, read or share: nothing reaches a deleted store.
UPDATE `business_stores` SET `deleted_at` = CAST(unixepoch('subsec') * 1000 AS INTEGER), `closing_at` = NULL, `closing_owner` = NULL WHERE `deleted_at` IS NULL AND `id` IN (SELECT `store_id` FROM `sdk_store_owners` WHERE `workflow_id` IS NOT NULL);--> statement-breakpoint
DROP TABLE `workflow_stores`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sdk_store_owners` (
	`store_id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`claimed_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_sdk_store_owners`("store_id", "app_id", "claimed_at") SELECT "store_id", "app_id", "claimed_at" FROM `sdk_store_owners` WHERE "app_id" IS NOT NULL;--> statement-breakpoint
DROP TABLE `sdk_store_owners`;--> statement-breakpoint
ALTER TABLE `__new_sdk_store_owners` RENAME TO `sdk_store_owners`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
-- Dropping the table dropped its guard (migration 0170): back as it was.
CREATE TRIGGER `sdk_store_owners_removed_app_insert` BEFORE INSERT ON `sdk_store_owners`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'sdk_store_owners: takes nothing new for a removed App');
END;
