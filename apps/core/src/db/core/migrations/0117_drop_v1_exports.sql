-- The v1 App server is gone (GRA-789): a version no longer has exports,
-- and another App's functions are reached through an app resource
-- (resource-apps.ts), never a permission. So an `app` permission is an
-- agent's, to `read` or `write` an App's functions, and nothing else:
-- one held by anything but an agent, or naming an export, no longer
-- parses, so it goes.
ALTER TABLE `app_versions` DROP COLUMN `exports`;
--> statement-breakpoint
DELETE FROM `permissions` WHERE `object_type` = 'app' AND `subject_type` <> 'agent';
--> statement-breakpoint
DELETE FROM `permissions` WHERE `object_type` = 'app' AND EXISTS (SELECT 1 FROM json_each(`actions`) WHERE `value` NOT IN ('read', 'write'));
