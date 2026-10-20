CREATE TABLE `workflow_resource_run_controls` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`app_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` integer NOT NULL,
	`stop_requested_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_resource_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_resource_run_controls_kind_idx` ON `workflow_resource_run_controls` (`run_id`,`kind`);--> statement-breakpoint
CREATE INDEX `workflow_resource_run_controls_run_idx` ON `workflow_resource_run_controls` (`run_id`,`state`);--> statement-breakpoint
CREATE INDEX `workflow_resource_run_controls_due_idx` ON `workflow_resource_run_controls` (`state`,`next_at`);--> statement-breakpoint
-- A cancel's receipt is written once and settled once
-- (screen-workflows.ts): who asked, for which run, under which key and
-- when never change; its state moves only from `admitted`, to `applied`
-- or `superseded`, with `settled_at` set as it does (while admitted, only
-- the repair's `attempts` and `next_at` move, and `stop_requested_at` is
-- set once, as its stop is first asked); and it is never
-- deleted. An insert of a key it holds is refused as 0101 refuses one,
-- reading as SQLite's own unique violation (isUniqueViolation).
CREATE TRIGGER `workflow_resource_run_controls_immutable_update` BEFORE UPDATE ON `workflow_resource_run_controls`
WHEN NOT (
	NEW.`id` IS OLD.`id`
	AND NEW.`run_id` IS OLD.`run_id`
	AND NEW.`app_id` IS OLD.`app_id`
	AND NEW.`principal_id` IS OLD.`principal_id`
	AND NEW.`key` IS OLD.`key`
	AND NEW.`kind` IS OLD.`kind`
	AND NEW.`created_at` IS OLD.`created_at`
	AND (
		NEW.`stop_requested_at` IS OLD.`stop_requested_at`
		OR (OLD.`stop_requested_at` IS NULL AND NEW.`stop_requested_at` IS NOT NULL)
	)
	AND OLD.`state` = 'admitted'
	AND OLD.`settled_at` IS NULL
	AND (
		(NEW.`state` = 'admitted' AND NEW.`settled_at` IS NULL)
		OR (NEW.`state` IN ('applied', 'superseded') AND NEW.`settled_at` IS NOT NULL)
	)
) BEGIN
	SELECT RAISE(ABORT, 'workflow_resource_run_controls are written once and settled once');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_run_controls_immutable_delete` BEFORE DELETE ON `workflow_resource_run_controls` BEGIN
	SELECT RAISE(ABORT, 'workflow_resource_run_controls are written once and settled once');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_run_controls_immutable_insert` BEFORE INSERT ON `workflow_resource_run_controls`
WHEN EXISTS (
	SELECT 1 FROM `workflow_resource_run_controls` WHERE `id` = NEW.`id`
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: workflow_resource_run_controls.id (workflow_resource_run_controls are written once)');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_run_controls_immutable_insert_kind` BEFORE INSERT ON `workflow_resource_run_controls`
WHEN EXISTS (
	SELECT 1 FROM `workflow_resource_run_controls`
	WHERE `run_id` = NEW.`run_id` AND `kind` = NEW.`kind`
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: workflow_resource_run_controls.run_id, workflow_resource_run_controls.kind (workflow_resource_run_controls are written once)');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_run_controls_immutable_insert_rowid` BEFORE INSERT ON `workflow_resource_run_controls`
WHEN EXISTS (
	SELECT 1 FROM `workflow_resource_run_controls` WHERE rowid = NEW.rowid AND NEW.rowid <> -1
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: workflow_resource_run_controls.rowid (workflow_resource_run_controls are written once)');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_run_controls_rowid_reserved` AFTER INSERT ON `workflow_resource_run_controls`
WHEN NEW.rowid = -1
BEGIN
	SELECT RAISE(ABORT, 'workflow_resource_run_controls keep rowid -1 for an insert that names none');
END;
