-- An `operation` binding is served by a store operation only: an approval
-- naming an App's export no longer parses, so it goes, with the release
-- pins it held.
DELETE FROM `workflow_binding_approvals` WHERE json_extract(`target`, '$.kind') = 'operation';
--> statement-breakpoint
DELETE FROM `sdk_release_pins` WHERE `holder_kind` = 'approval';
