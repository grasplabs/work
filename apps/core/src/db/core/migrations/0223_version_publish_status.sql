-- Publishing is one function (app-publish.ts), with a version's status and
-- the hash of the manifest it tested; artifacts are rows with a generation
-- each, referenced by seals (sealed-artifacts.ts). Expand only:
-- `app_candidates`, `app_candidate_reports`, `sdk_release_tombstones`,
-- `sdk_artifact_deletions`, `sdk_release_artifacts`,
-- `sdk_artifact_candidates`, and `sdk_release_manifests.last_current_at`
-- and `unreferenced_since` stay, unused, while a release that writes them
-- may still serve or be rolled back to; a later release drops them.
CREATE TABLE `sdk_artifact_refs` (
	`seal` text NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`seal`, `sha256`)
);
--> statement-breakpoint
CREATE INDEX `sdk_artifact_refs_sha256` ON `sdk_artifact_refs` (`sha256`);--> statement-breakpoint
CREATE TABLE `sdk_artifacts` (
	`sha256` text PRIMARY KEY NOT NULL,
	`generation` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `app_versions` ADD `status` text;--> statement-breakpoint
ALTER TABLE `app_versions` ADD `published_manifest_hash` text;--> statement-breakpoint
ALTER TABLE `sdk_release_manifests` ADD `seal_id` text;--> statement-breakpoint
ALTER TABLE `workflow_resource_versions` ADD `seal_id` text;--> statement-breakpoint
DROP TRIGGER `apps_current_from_candidate`;--> statement-breakpoint
-- A version is made current only while it is published, whoever writes
-- (src/apps.ts, `publishedSql`): it passed publishing, and the release it
-- tested is still stored. Or, for the release before this one, which may
-- still serve or be rolled back to, from its verified candidate over the
-- version current until then; the later release that drops the
-- candidates keeps only the first.
CREATE TRIGGER `apps_current_published` BEFORE UPDATE OF `current_version` ON `apps`
WHEN NEW.`current_version` IS NOT NULL
	AND NEW.`current_version` IS NOT OLD.`current_version`
	AND NOT EXISTS (SELECT 1 FROM `app_versions` AS `published`
		WHERE `published`.`app_id` = NEW.`id` AND `published`.`version` = NEW.`current_version`
			AND `published`.`status` = 'published'
			AND (`published`.`published_manifest_hash` IS NULL
				OR EXISTS (SELECT 1 FROM `sdk_release_manifests` AS `tested`
					WHERE `tested`.`app_id` = `published`.`app_id`
						AND `tested`.`version` = `published`.`version`
						AND `tested`.`manifest_hash` = `published`.`published_manifest_hash`)))
	AND NOT EXISTS (SELECT 1 FROM `app_candidates` AS `candidate`
		JOIN `app_candidate_reports` AS `report`
			ON `report`.`candidate_id` = `candidate`.`id` AND `report`.`hash` = `candidate`.`report_hash`
		WHERE `candidate`.`app_id` = NEW.`id` AND `candidate`.`version` = NEW.`current_version`
			AND `candidate`.`state` = 'verified'
			AND `candidate`.`based_on` IS coalesce(OLD.`current_version`, 0))
BEGIN
	SELECT RAISE(ABORT, 'apps are made current from a published version');
END;
