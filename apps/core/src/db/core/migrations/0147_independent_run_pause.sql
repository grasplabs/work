DROP INDEX `workflow_resource_run_controls_kind_idx`;--> statement-breakpoint
ALTER TABLE `workflow_resource_run_controls` ADD `generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_resource_run_controls_cancel_idx` ON `workflow_resource_run_controls` (`run_id`) WHERE "workflow_resource_run_controls"."kind" = 'cancel';--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_resource_run_controls_key_idx` ON `workflow_resource_run_controls` (`run_id`,`key`,`kind`);--> statement-breakpoint
ALTER TABLE `workflow_resource_runs` ADD `control_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_resource_runs` ADD `summary_revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- A screen's pause and resume of an independent run get receipts beside its
-- cancel (screen-workflows.ts): a run takes as many as it is paused and
-- resumed, so only a cancel stays one per run. Each keeps the control
-- generation it was admitted under, which never changes, as nothing else
-- of a receipt does but its single settle (0108).
DROP TRIGGER `workflow_resource_run_controls_immutable_update`;--> statement-breakpoint
CREATE TRIGGER `workflow_resource_run_controls_immutable_update` BEFORE UPDATE ON `workflow_resource_run_controls`
WHEN NOT (
	NEW.`id` IS OLD.`id`
	AND NEW.`run_id` IS OLD.`run_id`
	AND NEW.`app_id` IS OLD.`app_id`
	AND NEW.`principal_id` IS OLD.`principal_id`
	AND NEW.`key` IS OLD.`key`
	AND NEW.`kind` IS OLD.`kind`
	AND NEW.`generation` IS OLD.`generation`
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
DROP TRIGGER `workflow_resource_run_controls_immutable_insert_kind`;--> statement-breakpoint
CREATE TRIGGER `workflow_resource_run_controls_immutable_insert_cancel` BEFORE INSERT ON `workflow_resource_run_controls`
WHEN NEW.`kind` = 'cancel' AND EXISTS (
	SELECT 1 FROM `workflow_resource_run_controls`
	WHERE `run_id` = NEW.`run_id` AND `kind` = 'cancel'
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: workflow_resource_run_controls.run_id (workflow_resource_run_controls are written once)');
END;

--> statement-breakpoint
CREATE TABLE `workflow_resource_run_control_keys` (
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`receipt_id` text NOT NULL,
	PRIMARY KEY(`run_id`, `kind`, `key`),
	FOREIGN KEY (`run_id`) REFERENCES `workflow_resource_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`receipt_id`) REFERENCES `workflow_resource_run_controls`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- A key answers the receipt it was first given, for good: written once,
-- never changed or removed, as the receipts themselves (0108).
CREATE TRIGGER `workflow_resource_run_control_keys_immutable_update` BEFORE UPDATE ON `workflow_resource_run_control_keys` BEGIN
	SELECT RAISE(ABORT, 'workflow_resource_run_control_keys are written once');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_run_control_keys_immutable_delete` BEFORE DELETE ON `workflow_resource_run_control_keys` BEGIN
	SELECT RAISE(ABORT, 'workflow_resource_run_control_keys are written once');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_run_control_keys_immutable_insert` BEFORE INSERT ON `workflow_resource_run_control_keys`
WHEN EXISTS (
	SELECT 1 FROM `workflow_resource_run_control_keys`
	WHERE `run_id` = NEW.`run_id` AND `kind` = NEW.`kind` AND `key` = NEW.`key`
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: workflow_resource_run_control_keys.run_id, workflow_resource_run_control_keys.kind, workflow_resource_run_control_keys.key (workflow_resource_run_control_keys are written once)');
END;
