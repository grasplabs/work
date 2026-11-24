-- Expand only: the release before this one may still serve while this
-- one's code is uploaded, or for good if the upload fails, so every
-- table and column it reads stays. `pages` is added beside `screens` and
-- set from it; a version that release commits meanwhile gets none (the
-- default), which its next version puts right. `app_versions.screens`
-- and `notifications.screen` go once no release reads them, and
-- `screen_policies` keeps its name until then (schema.ts, GRA-1606).
ALTER TABLE `app_versions` ADD `pages` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `app_versions` SET `pages` = true WHERE `screens` != '[]';
