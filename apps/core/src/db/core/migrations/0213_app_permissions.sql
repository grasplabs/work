-- An App's `uses` became its `permissions` (GRA-1533): templates, other
-- stores and the App's own statistics are no permission any more, so no
-- binding serves one, and no release's inventory names a store resource.
-- Their rows go: their targets are no binding target there is.
DELETE FROM `app_resource_bindings` WHERE `kind` IN ('template', 'store', 'statistics');--> statement-breakpoint
DELETE FROM `sdk_resource_bindings` WHERE `kind` = 'storeResource';
