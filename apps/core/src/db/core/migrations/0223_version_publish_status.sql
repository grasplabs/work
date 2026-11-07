-- A version's publishing status (app-publish.ts): publishing is one function
-- now, replacing candidates. `app_candidates`, `app_candidate_reports`,
-- `sdk_release_tombstones`, `sdk_artifact_deletions`, and
-- `sdk_release_manifests.last_current_at` and `unreferenced_since` stay,
-- unused, while a release that writes them may still serve or be rolled
-- back to (expand, then contract); a later release drops them.
ALTER TABLE `app_versions` ADD `status` text;
--> statement-breakpoint
DROP TRIGGER `apps_current_from_candidate`;
--> statement-breakpoint
-- A version is made current only once it is published (src/apps.ts,
-- `makeCurrent`), whoever writes; or, for the release before this one,
-- which may still serve or be rolled back to, from its verified candidate
-- over the version current until then. The later release that drops the
-- candidates keeps only the first.
CREATE TRIGGER `apps_current_published` BEFORE UPDATE OF `current_version` ON `apps`
WHEN NEW.`current_version` IS NOT NULL
	AND NEW.`current_version` IS NOT OLD.`current_version`
	AND NOT EXISTS (SELECT 1 FROM `app_versions`
		WHERE `app_id` = NEW.`id` AND `version` = NEW.`current_version`
			AND `status` = 'published')
	AND NOT EXISTS (SELECT 1 FROM `app_candidates` AS `candidate`
		JOIN `app_candidate_reports` AS `report`
			ON `report`.`candidate_id` = `candidate`.`id` AND `report`.`hash` = `candidate`.`report_hash`
		WHERE `candidate`.`app_id` = NEW.`id` AND `candidate`.`version` = NEW.`current_version`
			AND `candidate`.`state` = 'verified'
			AND `candidate`.`based_on` IS coalesce(OLD.`current_version`, 0))
BEGIN
	SELECT RAISE(ABORT, 'apps are made current from a published version');
END;
