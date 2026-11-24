ALTER TABLE `workflow_resource_runs` ADD `restricted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_start_receipts` ADD `restricted` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Whether a start was decided in restricted mode is written once, with
-- its receipt and its run, and never changes (restricted.ts): the
-- triggers that keep both as they were written now cover it too.
DROP TRIGGER `workflow_start_receipts_immutable_update`;
--> statement-breakpoint
CREATE TRIGGER `workflow_start_receipts_immutable_update` BEFORE UPDATE ON `workflow_start_receipts`
WHEN NOT (
	NEW.`id` IS OLD.`id`
	AND NEW.`invoker_type` IS OLD.`invoker_type`
	AND NEW.`invoker_id` IS OLD.`invoker_id`
	AND NEW.`idempotency_key` IS OLD.`idempotency_key`
	AND NEW.`workflow_resource_id` IS OLD.`workflow_resource_id`
	AND NEW.`workflow_resource_version` IS OLD.`workflow_resource_version`
	AND NEW.`manifest_hash` IS OLD.`manifest_hash`
	AND NEW.`origin_app_version` IS OLD.`origin_app_version`
	AND NEW.`trigger_version` IS OLD.`trigger_version`
	AND NEW.`principal_id` IS OLD.`principal_id`
	AND NEW.`authority_generation` IS OLD.`authority_generation`
	AND NEW.`input_hash` IS OLD.`input_hash`
	AND NEW.`params_revision` IS OLD.`params_revision`
	AND NEW.`bindings` IS OLD.`bindings`
	AND NEW.`bindings_hash` IS OLD.`bindings_hash`
	AND NEW.`created_at` IS OLD.`created_at`
	AND NEW.`restricted` IS OLD.`restricted`
	AND OLD.`details_removed_at` IS NULL
	AND NEW.`details_removed_at` IS NOT NULL
	AND NEW.`input` IS NULL
	AND NEW.`params` IS NULL
) BEGIN
	SELECT RAISE(ABORT, 'workflow_start_receipts are immutable');
END;
--> statement-breakpoint
DROP TRIGGER `workflow_resource_runs_pinned`;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_runs_pinned` BEFORE UPDATE ON `workflow_resource_runs`
WHEN OLD.`status` IN ('completed', 'failed', 'cancelled') OR NOT (
	NEW.`id` IS OLD.`id`
	AND NEW.`workflow_resource_id` IS OLD.`workflow_resource_id`
	AND NEW.`version` IS OLD.`version`
	AND NEW.`manifest_hash` IS OLD.`manifest_hash`
	AND NEW.`build_hash` IS OLD.`build_hash`
	AND NEW.`principal_id` IS OLD.`principal_id`
	AND NEW.`created_at` IS OLD.`created_at`
	AND NEW.`restricted` IS OLD.`restricted`
) BEGIN
	SELECT RAISE(ABORT, 'workflow_resource_runs pin what they run, and an ended run stays ended');
END;
