DROP INDEX `workflow_resources_name_unique`;--> statement-breakpoint
ALTER TABLE `workflow_resources` ADD `name_released_at` integer;--> statement-breakpoint
ALTER TABLE `workflow_resources` ADD `name_released_by` text;--> statement-breakpoint
CREATE INDEX `workflow_resources_name_released` ON `workflow_resources` (`name`,`name_released_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_resources_name_unique` ON `workflow_resources` (`name`) WHERE name_released_at IS NULL;
--> statement-breakpoint
-- A released name stays released, and its workflow is never live again,
-- so two live workflows never share a name, whatever code runs
-- (workflow-resources.ts `releaseWorkflowName`, GRA-562). Only a deleted
-- workflow's name is released, and a released row's name never changes.
CREATE TRIGGER `workflow_resources_name_released_kept` BEFORE UPDATE ON `workflow_resources`
WHEN OLD.`name_released_at` IS NOT NULL AND (
	NEW.`name_released_at` IS NULL
	OR NEW.`name_released_at` <> OLD.`name_released_at`
	OR NEW.`name_released_by` IS NOT OLD.`name_released_by`
	OR NEW.`deleted_at` IS NULL
	OR NEW.`name` <> OLD.`name`
) BEGIN
	SELECT RAISE(ABORT, 'workflow_resources: a released name stays released, and its workflow deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resources_name_released_deleted` BEFORE UPDATE OF `name_released_at`, `name_released_by` ON `workflow_resources`
WHEN OLD.`name_released_at` IS NULL AND (NEW.`name_released_at` IS NOT NULL OR NEW.`name_released_by` IS NOT NULL)
	AND (NEW.`deleted_at` IS NULL OR NEW.`name_released_at` IS NULL OR NEW.`name_released_by` IS NULL)
BEGIN
	SELECT RAISE(ABORT, 'workflow_resources: only a deleted workflow''s name is released, by someone');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resources_name_released_insert` BEFORE INSERT ON `workflow_resources`
WHEN NEW.`name_released_at` IS NOT NULL OR NEW.`name_released_by` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'workflow_resources: a new workflow holds its name');
END;
--> statement-breakpoint
-- An insert over an existing row (REPLACE, or an upsert) would bring a
-- released workflow back, or reset a deleted one: refused by its ID and
-- by its rowid, as migration 0101 refuses them for versions and receipts
-- (see there for why rowid -1 is left out, and kept from use).
CREATE TRIGGER `workflow_resources_immutable_insert` BEFORE INSERT ON `workflow_resources`
WHEN EXISTS (SELECT 1 FROM `workflow_resources` WHERE `id` = NEW.`id`)
BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: workflow_resources.id (a workflow keeps its row)');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resources_immutable_insert_rowid` BEFORE INSERT ON `workflow_resources`
WHEN EXISTS (
	SELECT 1 FROM `workflow_resources` WHERE rowid = NEW.rowid AND NEW.rowid <> -1
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: workflow_resources.rowid (a workflow keeps its row)');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resources_rowid_reserved` AFTER INSERT ON `workflow_resources`
WHEN NEW.rowid = -1
BEGIN
	SELECT RAISE(ABORT, 'workflow_resources keep rowid -1 for an insert that names none');
END;
