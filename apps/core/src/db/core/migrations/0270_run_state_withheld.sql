ALTER TABLE `workflow_candidate_runs` ADD `state_withheld` integer;--> statement-breakpoint
ALTER TABLE `workflow_start_receipts` ADD `state_withheld` integer;--> statement-breakpoint
-- How many kept keys a start's run started without is written once, with
-- its receipt, and never changes (workflow-state.ts), and the hash of the
-- snapshot it froze only goes with the receipt's details (retention.ts):
-- the trigger that keeps a receipt as it was written now covers both.
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
	AND NEW.`state_withheld` IS OLD.`state_withheld`
	AND OLD.`details_removed_at` IS NULL
	AND NEW.`details_removed_at` IS NOT NULL
	AND NEW.`input` IS NULL
	AND NEW.`params` IS NULL
	AND NEW.`state_hash` IS NULL
) BEGIN
	SELECT RAISE(ABORT, 'workflow_start_receipts are immutable');
END;
