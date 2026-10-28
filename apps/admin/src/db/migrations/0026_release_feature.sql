ALTER TABLE `releases` ADD `feature` integer;--> statement-breakpoint
-- Whether each release imported before the column is a feature, by the
-- rule the import follows (src/releases/version.ts): its note is a
-- Conventional Commit `feat`, scoped or not, breaking or not.
UPDATE `releases` SET `feature` = CASE WHEN coalesce(json_extract(`manifest`, '$.notes'), '') GLOB 'feat[(:!]*' THEN 1 ELSE 0 END;
