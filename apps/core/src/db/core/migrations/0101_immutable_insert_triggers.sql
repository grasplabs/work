-- What 0080, 0089 and 0095 refuse to update or delete could still be
-- overwritten by an insert: INSERT OR REPLACE (or REPLACE INTO) on a key
-- that exists deletes the old row itself, and with recursive_triggers off
-- that deletion fires no DELETE trigger, so the row was replaced in place.
-- Each table now refuses an insert of any key it already holds, primary
-- or unique, before SQLite decides how to resolve the conflict: REPLACE,
-- ON CONFLICT DO UPDATE and OR IGNORE alike are refused, never resolved.
--
-- The refusal reads as SQLite's own unique violation, which is what it
-- is, so the write paths that turn a taken key into an answer
-- (isUniqueViolation in db/d1.ts: a contract that exists, a parameter
-- revision or a start receipt written as this ran) read it unchanged.
-- `=` matches as the unique index does: a NULL never collides.
--
-- The rowid is a key too: none of these tables has an INTEGER PRIMARY KEY,
-- so each row has an implicit rowid an insert may name, and REPLACE under
-- a new key with an old row's rowid deleted that row just the same,
-- leaving its key free for a plain insert. An insert that names no rowid
-- has NEW.rowid -1 in a BEFORE trigger, so -1 is left out of the lookup,
-- and an AFTER trigger keeps any row from being written with rowid -1:
-- otherwise one such row would match, and refuse, every ordinary insert.
CREATE TRIGGER `workflow_resource_versions_immutable_insert` BEFORE INSERT ON `workflow_resource_versions`
WHEN EXISTS (
	SELECT 1 FROM `workflow_resource_versions`
	WHERE `workflow_resource_id` = NEW.`workflow_resource_id` AND `version` = NEW.`version`
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: workflow_resource_versions.workflow_resource_id, workflow_resource_versions.version (workflow_resource_versions are immutable)');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_versions_immutable_insert_definition_version` BEFORE INSERT ON `workflow_resource_versions`
WHEN EXISTS (
	SELECT 1 FROM `workflow_resource_versions`
	WHERE `workflow_resource_id` = NEW.`workflow_resource_id` AND `definition_version` = NEW.`definition_version`
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: workflow_resource_versions.workflow_resource_id, workflow_resource_versions.definition_version (workflow_resource_versions are immutable)');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_start_receipts_immutable_insert` BEFORE INSERT ON `workflow_start_receipts`
WHEN EXISTS (
	SELECT 1 FROM `workflow_start_receipts` WHERE `id` = NEW.`id`
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: workflow_start_receipts.id (workflow_start_receipts are immutable)');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_start_receipts_immutable_insert_key` BEFORE INSERT ON `workflow_start_receipts`
WHEN EXISTS (
	SELECT 1 FROM `workflow_start_receipts`
	WHERE `invoker_type` = NEW.`invoker_type` AND `invoker_id` = NEW.`invoker_id`
		AND `principal_id` = NEW.`principal_id` AND `idempotency_key` = NEW.`idempotency_key`
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: workflow_start_receipts.invoker_type, workflow_start_receipts.invoker_id, workflow_start_receipts.principal_id, workflow_start_receipts.idempotency_key (workflow_start_receipts are immutable)');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_params_immutable_insert` BEFORE INSERT ON `workflow_resource_params`
WHEN EXISTS (
	SELECT 1 FROM `workflow_resource_params`
	WHERE `workflow_resource_id` = NEW.`workflow_resource_id` AND `revision` = NEW.`revision`
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: workflow_resource_params.workflow_resource_id, workflow_resource_params.revision (workflow_resource_params are immutable)');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_catalog_contracts_immutable_insert` BEFORE INSERT ON `workflow_catalog_contracts`
WHEN EXISTS (
	SELECT 1 FROM `workflow_catalog_contracts` WHERE `key` = NEW.`key`
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: workflow_catalog_contracts.key (workflow_catalog_contracts are immutable)');
END;
--> statement-breakpoint
CREATE TRIGGER `trigger_resource_versions_immutable_insert` BEFORE INSERT ON `trigger_resource_versions`
WHEN EXISTS (
	SELECT 1 FROM `trigger_resource_versions`
	WHERE `trigger_id` = NEW.`trigger_id` AND `version` = NEW.`version`
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: trigger_resource_versions.trigger_id, trigger_resource_versions.version (trigger_resource_versions are immutable)');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_runs_immutable_insert` BEFORE INSERT ON `workflow_resource_runs`
WHEN EXISTS (
	SELECT 1 FROM `workflow_resource_runs` WHERE `id` = NEW.`id`
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: workflow_resource_runs.id (workflow_resource_runs pin what they run and are kept)');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_versions_immutable_insert_rowid` BEFORE INSERT ON `workflow_resource_versions`
WHEN EXISTS (
	SELECT 1 FROM `workflow_resource_versions` WHERE rowid = NEW.rowid AND NEW.rowid <> -1
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: workflow_resource_versions.rowid (workflow_resource_versions are immutable)');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_start_receipts_immutable_insert_rowid` BEFORE INSERT ON `workflow_start_receipts`
WHEN EXISTS (
	SELECT 1 FROM `workflow_start_receipts` WHERE rowid = NEW.rowid AND NEW.rowid <> -1
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: workflow_start_receipts.rowid (workflow_start_receipts are immutable)');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_params_immutable_insert_rowid` BEFORE INSERT ON `workflow_resource_params`
WHEN EXISTS (
	SELECT 1 FROM `workflow_resource_params` WHERE rowid = NEW.rowid AND NEW.rowid <> -1
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: workflow_resource_params.rowid (workflow_resource_params are immutable)');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_catalog_contracts_immutable_insert_rowid` BEFORE INSERT ON `workflow_catalog_contracts`
WHEN EXISTS (
	SELECT 1 FROM `workflow_catalog_contracts` WHERE rowid = NEW.rowid AND NEW.rowid <> -1
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: workflow_catalog_contracts.rowid (workflow_catalog_contracts are immutable)');
END;
--> statement-breakpoint
CREATE TRIGGER `trigger_resource_versions_immutable_insert_rowid` BEFORE INSERT ON `trigger_resource_versions`
WHEN EXISTS (
	SELECT 1 FROM `trigger_resource_versions` WHERE rowid = NEW.rowid AND NEW.rowid <> -1
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: trigger_resource_versions.rowid (trigger_resource_versions are immutable)');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_runs_immutable_insert_rowid` BEFORE INSERT ON `workflow_resource_runs`
WHEN EXISTS (
	SELECT 1 FROM `workflow_resource_runs` WHERE rowid = NEW.rowid AND NEW.rowid <> -1
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: workflow_resource_runs.rowid (workflow_resource_runs pin what they run and are kept)');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_versions_rowid_reserved` AFTER INSERT ON `workflow_resource_versions`
WHEN NEW.rowid = -1
BEGIN
	SELECT RAISE(ABORT, 'workflow_resource_versions keep rowid -1 for an insert that names none');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_start_receipts_rowid_reserved` AFTER INSERT ON `workflow_start_receipts`
WHEN NEW.rowid = -1
BEGIN
	SELECT RAISE(ABORT, 'workflow_start_receipts keep rowid -1 for an insert that names none');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_params_rowid_reserved` AFTER INSERT ON `workflow_resource_params`
WHEN NEW.rowid = -1
BEGIN
	SELECT RAISE(ABORT, 'workflow_resource_params keep rowid -1 for an insert that names none');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_catalog_contracts_rowid_reserved` AFTER INSERT ON `workflow_catalog_contracts`
WHEN NEW.rowid = -1
BEGIN
	SELECT RAISE(ABORT, 'workflow_catalog_contracts keep rowid -1 for an insert that names none');
END;
--> statement-breakpoint
CREATE TRIGGER `trigger_resource_versions_rowid_reserved` AFTER INSERT ON `trigger_resource_versions`
WHEN NEW.rowid = -1
BEGIN
	SELECT RAISE(ABORT, 'trigger_resource_versions keep rowid -1 for an insert that names none');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_runs_rowid_reserved` AFTER INSERT ON `workflow_resource_runs`
WHEN NEW.rowid = -1
BEGIN
	SELECT RAISE(ABORT, 'workflow_resource_runs keep rowid -1 for an insert that names none');
END;
