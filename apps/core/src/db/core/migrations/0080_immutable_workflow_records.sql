-- What independent workflows freeze is written once and never changed or
-- removed (workflow-resources.ts, workflow-starts.ts): published versions,
-- start receipts with their frozen parameters and bindings, parameter
-- revisions, catalog contracts and trigger versions. The database refuses
-- any update or deletion of them, whatever code asks, with one exception:
-- run retention (workflows/retention.ts) may remove what a person put in,
-- a receipt's input and frozen parameter values and a replaced revision's
-- values, by setting them to null once, with when it did. Every ID, hash
-- and link stays as it was written.
CREATE TRIGGER `workflow_resource_versions_immutable_update` BEFORE UPDATE ON `workflow_resource_versions` BEGIN
	SELECT RAISE(ABORT, 'workflow_resource_versions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_versions_immutable_delete` BEFORE DELETE ON `workflow_resource_versions` BEGIN
	SELECT RAISE(ABORT, 'workflow_resource_versions are immutable');
END;
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
	AND OLD.`details_removed_at` IS NULL
	AND NEW.`details_removed_at` IS NOT NULL
	AND NEW.`input` IS NULL
	AND NEW.`params` IS NULL
) BEGIN
	SELECT RAISE(ABORT, 'workflow_start_receipts are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_start_receipts_immutable_delete` BEFORE DELETE ON `workflow_start_receipts` BEGIN
	SELECT RAISE(ABORT, 'workflow_start_receipts are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_params_immutable_update` BEFORE UPDATE ON `workflow_resource_params`
WHEN NOT (
	NEW.`workflow_resource_id` IS OLD.`workflow_resource_id`
	AND NEW.`revision` IS OLD.`revision`
	AND NEW.`set_by` IS OLD.`set_by`
	AND NEW.`set_at` IS OLD.`set_at`
	AND OLD.`values_removed_at` IS NULL
	AND NEW.`values_removed_at` IS NOT NULL
	AND NEW.`values` IS NULL
) BEGIN
	SELECT RAISE(ABORT, 'workflow_resource_params are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_resource_params_immutable_delete` BEFORE DELETE ON `workflow_resource_params` BEGIN
	SELECT RAISE(ABORT, 'workflow_resource_params are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_catalog_contracts_immutable_update` BEFORE UPDATE ON `workflow_catalog_contracts` BEGIN
	SELECT RAISE(ABORT, 'workflow_catalog_contracts are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_catalog_contracts_immutable_delete` BEFORE DELETE ON `workflow_catalog_contracts` BEGIN
	SELECT RAISE(ABORT, 'workflow_catalog_contracts are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trigger_resource_versions_immutable_update` BEFORE UPDATE ON `trigger_resource_versions` BEGIN
	SELECT RAISE(ABORT, 'trigger_resource_versions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trigger_resource_versions_immutable_delete` BEFORE DELETE ON `trigger_resource_versions` BEGIN
	SELECT RAISE(ABORT, 'trigger_resource_versions are immutable');
END;
