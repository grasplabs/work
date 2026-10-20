-- What the sweep of preview stores reads by, and when it tries a store
-- again (sealed-previews.ts, `sweepPreviewStores`, GRA-817).
ALTER TABLE `preview_fixture_stores` ADD `retry_after` integer;--> statement-breakpoint
CREATE INDEX `preview_fixture_stores_created_at` ON `preview_fixture_stores` (`created_at`);