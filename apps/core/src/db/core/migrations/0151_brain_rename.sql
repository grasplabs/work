-- GRA-1095: Knowledge is the Brain. What was stored as `knowledge` (a
-- resource or binding kind, and the kind of a binding's target) is
-- `brain`: no alias is kept (hard cut). Sealed builds and definitions
-- naming the old kind are published again.
UPDATE `sdk_resource_bindings` SET `kind` = 'brain' WHERE `kind` = 'knowledge';--> statement-breakpoint
UPDATE `app_resource_bindings` SET `kind` = 'brain' WHERE `kind` = 'knowledge';--> statement-breakpoint
UPDATE `app_resource_bindings` SET `target` = json_set(`target`, '$.kind', 'brain') WHERE json_valid(`target`) AND json_extract(`target`, '$.kind') = 'knowledge';--> statement-breakpoint
UPDATE `workflow_catalog_contracts` SET `kind` = 'brain' WHERE `kind` = 'knowledge';--> statement-breakpoint
UPDATE `workflow_catalog_contracts` SET `contract` = json_set(`contract`, '$.kind', 'brain') WHERE json_valid(`contract`) AND json_extract(`contract`, '$.kind') = 'knowledge';--> statement-breakpoint
UPDATE `workflow_binding_approvals` SET `kind` = 'brain' WHERE `kind` = 'knowledge';--> statement-breakpoint
UPDATE `workflow_binding_approvals` SET `target` = json_set(`target`, '$.kind', 'brain') WHERE json_valid(`target`) AND json_extract(`target`, '$.kind') = 'knowledge';
