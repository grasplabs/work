ALTER TABLE `sdk_resource_bindings` ADD `target_path` text;--> statement-breakpoint
ALTER TABLE `sdk_resource_bindings` ADD `approval_id` text;--> statement-breakpoint
-- An operation binding names a store and path (`target_path`) only with
-- the approval that resolved them (`approval_id`), and both go together
-- (workflow-bindings.ts): so a consumer counted by its approval
-- (data-stores.ts, `consumersSql`) is never missed for a row left without it.
CREATE TRIGGER `sdk_resource_bindings_projection_insert` BEFORE INSERT ON `sdk_resource_bindings`
WHEN NEW.`kind` = 'operation' AND ((NEW.`target_path` IS NULL) <> (NEW.`approval_id` IS NULL))
BEGIN
	SELECT RAISE(ABORT, 'sdk_resource_bindings: an operation names its store only with its approval');
END;
--> statement-breakpoint
CREATE TRIGGER `sdk_resource_bindings_projection_update` BEFORE UPDATE OF `kind`, `target_path`, `approval_id` ON `sdk_resource_bindings`
WHEN NEW.`kind` = 'operation' AND ((NEW.`target_path` IS NULL) <> (NEW.`approval_id` IS NULL))
BEGIN
	SELECT RAISE(ABORT, 'sdk_resource_bindings: an operation names its store only with its approval');
END;
