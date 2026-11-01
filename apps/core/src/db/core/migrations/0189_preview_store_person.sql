-- Whose chat's preview each store is, so removing the person discards
-- it at once (sealed-previews.ts, `discardPreviewStoresOf`, GRA-897).
ALTER TABLE `preview_fixture_stores` ADD `person_id` text;--> statement-breakpoint
CREATE INDEX `preview_fixture_stores_person` ON `preview_fixture_stores` (`person_id`);