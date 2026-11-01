-- An App's store-resource binding names a store (a `target_id` other than
-- its declaration's hash) only with the approval that resolved it
-- (`approval_id`), and both go together (resource-declarations.ts): so an
-- App counted by its approval (data-stores.ts, `consumersSql`) is never
-- missed for a row left without it.
CREATE TRIGGER `sdk_resource_bindings_store_resource_insert` BEFORE INSERT ON `sdk_resource_bindings`
WHEN NEW.`kind` = 'storeResource' AND ((NEW.`approval_id` IS NULL) <> (NEW.`target_id` IS NEW.`schema_hash`))
BEGIN
	SELECT RAISE(ABORT, 'sdk_resource_bindings: a store resource names its store only with its approval');
END;
--> statement-breakpoint
CREATE TRIGGER `sdk_resource_bindings_store_resource_update` BEFORE UPDATE OF `kind`, `target_id`, `schema_hash`, `approval_id` ON `sdk_resource_bindings`
WHEN NEW.`kind` = 'storeResource' AND ((NEW.`approval_id` IS NULL) <> (NEW.`target_id` IS NEW.`schema_hash`))
BEGIN
	SELECT RAISE(ABORT, 'sdk_resource_bindings: a store resource names its store only with its approval');
END;
