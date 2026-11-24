ALTER TABLE `apps` ADD `removed_at` integer;--> statement-breakpoint
ALTER TABLE `apps` ADD `removed_by` text;
--> statement-breakpoint
-- A removed App (app-removal.ts) takes nothing new, whatever code runs
-- and whenever it read the App: a write that read it before its removal
-- and lands after is refused here, in one place for every writer, rather
-- than by each writer's own guard (GRA-1120); `auditedBatch` answers it
-- as `app.not_found`. Ending things stays open everywhere: no delete is
-- refused, a permission may still be revoked, a binding still leave
-- `active`, a run or start still end, so the removal itself, the cron
-- trigger cancelling its runs, retention and erasure all go on.
--
-- Every table that names an App is classified (removed-app-guard.test.ts
-- fails on one that isn't): refusing new rows below, or open on purpose:
-- - access_revocations: records of access ended, which removal and
--   revocation write.
-- - notifications, app_statistics, app_statistic_steps,
--   improvement_signals, dependency_admission_refusals: records of what
--   happened, written as runs end and work settles.
-- - migration_samples, migration_sample_leases: an admin's samples of a
--   removed App's store, which its admins manage from then on
--   (data-stores.ts `requireStoreChangeable`).
-- - run_lineage_accounts, workflow_resource_run_controls: what ending and
--   cancelling its runs keep and write.
-- - sdk_release_pins, sdk_release_tombstones:
--   retention, which reaps its releases.
-- - dependency_approvers: names people and teams, never an App.
-- - landscape_apps, landscape_app_people, landscape_staged_apps,
--   landscape_staged_people: their `app_id` is a third-party app's.
--
-- The App's own row: what it is and whom it reaches never changes once
-- removed (its status, owner, versions, audience, removal); its name,
-- description and creation time stay open, for erasure, retention and
-- migrations, the settings page's writes refusing a removed App in code
-- (app-settings.ts).
CREATE TRIGGER `apps_removed_kept` BEFORE UPDATE OF `status`, `status_changed_at`, `status_changed_by`, `removed_at`, `removed_by`, `owner_id`, `blueprint`, `current_version`, `pending_version`, `responsible_id`, `audience_type`, `audience_id` ON `apps`
WHEN OLD.`removed_at` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'apps: a removed App stays as it was removed');
END;
--> statement-breakpoint
CREATE TRIGGER `app_members_removed_app_insert` BEFORE INSERT ON `app_members`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_members: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `app_integrations_removed_app_insert` BEFORE INSERT ON `app_integrations`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_integrations: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `app_resource_bindings_removed_app_insert` BEFORE INSERT ON `app_resource_bindings`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_resource_bindings: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `app_workflow_bindings_removed_app_insert` BEFORE INSERT ON `app_workflow_bindings`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_workflow_bindings: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `app_versions_removed_app_insert` BEFORE INSERT ON `app_versions`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_versions: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `app_candidates_removed_app_insert` BEFORE INSERT ON `app_candidates`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_candidates: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `app_origins_removed_app_insert` BEFORE INSERT ON `app_origins`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_origins: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `app_default_stores_removed_app_insert` BEFORE INSERT ON `app_default_stores`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_default_stores: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `app_entries_removed_app_insert` BEFORE INSERT ON `app_entries`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_entries: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `app_test_runs_removed_app_insert` BEFORE INSERT ON `app_test_runs`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_test_runs: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `app_test_fixtures_removed_app_insert` BEFORE INSERT ON `app_test_fixtures`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_test_fixtures: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `guest_chats_removed_app_insert` BEFORE INSERT ON `guest_chats`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'guest_chats: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_triggers_removed_app_insert` BEFORE INSERT ON `workflow_triggers`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'workflow_triggers: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_owners_removed_app_insert` BEFORE INSERT ON `workflow_owners`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'workflow_owners: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_teams_removed_app_insert` BEFORE INSERT ON `workflow_teams`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'workflow_teams: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_param_values_removed_app_insert` BEFORE INSERT ON `workflow_param_values`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'workflow_param_values: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_runs_removed_app_insert` BEFORE INSERT ON `workflow_runs`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'workflow_runs: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `blueprints_removed_app_insert` BEFORE INSERT ON `blueprints`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'blueprints: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `policy_exceptions_removed_app_insert` BEFORE INSERT ON `policy_exceptions`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'policy_exceptions: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `sdk_store_owners_removed_app_insert` BEFORE INSERT ON `sdk_store_owners`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'sdk_store_owners: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `sdk_release_manifests_removed_app_insert` BEFORE INSERT ON `sdk_release_manifests`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'sdk_release_manifests: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `sdk_release_artifacts_removed_app_insert` BEFORE INSERT ON `sdk_release_artifacts`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'sdk_release_artifacts: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `screen_builds_removed_app_insert` BEFORE INSERT ON `screen_builds`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'screen_builds: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `screen_artifacts_removed_app_insert` BEFORE INSERT ON `screen_artifacts`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'screen_artifacts: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `screen_policies_removed_app_insert` BEFORE INSERT ON `screen_policies`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'screen_policies: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `screen_submissions_removed_app_insert` BEFORE INSERT ON `screen_submissions`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'screen_submissions: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `action_invocations_removed_app_insert` BEFORE INSERT ON `action_invocations`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'action_invocations: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `preview_fixture_stores_removed_app_insert` BEFORE INSERT ON `preview_fixture_stores`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'preview_fixture_stores: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `permissions_removed_app_insert` BEFORE INSERT ON `permissions`
WHEN (NEW.`subject_type` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`subject_id` AND `removed_at` IS NOT NULL))
	OR (NEW.`object_type` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`object_id` AND `removed_at` IS NOT NULL))
BEGIN
	SELECT RAISE(ABORT, 'permissions: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_start_receipts_removed_app_insert` BEFORE INSERT ON `workflow_start_receipts`
WHEN NEW.`invoker_type` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`invoker_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'workflow_start_receipts: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `dependency_requests_removed_app_insert` BEFORE INSERT ON `dependency_requests`
WHEN NEW.`subject_type` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`subject_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'dependency_requests: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `dependency_locks_removed_app_insert` BEFORE INSERT ON `dependency_locks`
WHEN NEW.`subject_type` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`subject_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'dependency_locks: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `dependency_build_leases_removed_app_insert` BEFORE INSERT ON `dependency_build_leases`
WHEN NEW.`subject_type` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`subject_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'dependency_build_leases: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `sdk_resource_bindings_removed_app_insert` BEFORE INSERT ON `sdk_resource_bindings`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`resource_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'sdk_resource_bindings: takes nothing new for a removed App');
END;
--> statement-breakpoint
-- Only towards revoked.
CREATE TRIGGER `permissions_removed_app_update` BEFORE UPDATE ON `permissions`
WHEN NEW.`status` <> 'revoked' AND (
	(NEW.`subject_type` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`subject_id` AND `removed_at` IS NOT NULL))
	OR (NEW.`object_type` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`object_id` AND `removed_at` IS NOT NULL))
)
BEGIN
	SELECT RAISE(ABORT, 'permissions: takes nothing new for a removed App');
END;
--> statement-breakpoint
-- Never back to active.
CREATE TRIGGER `app_resource_bindings_removed_app_update` BEFORE UPDATE ON `app_resource_bindings`
WHEN NEW.`status` = 'active' AND OLD.`status` <> 'active' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_resource_bindings: takes nothing new for a removed App');
END;
--> statement-breakpoint
-- Never back to active.
CREATE TRIGGER `app_workflow_bindings_removed_app_update` BEFORE UPDATE ON `app_workflow_bindings`
WHEN NEW.`status` = 'active' AND OLD.`status` <> 'active' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_workflow_bindings: takes nothing new for a removed App');
END;
--> statement-breakpoint
-- Never a role raised (its rows go with the removal; an integration's
-- row has no state to make live again, so only its insert is refused).
CREATE TRIGGER `app_members_removed_app_update` BEFORE UPDATE ON `app_members`
WHEN NEW.`role` = 'builder' AND OLD.`role` <> 'builder' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_members: takes nothing new for a removed App');
END;
--> statement-breakpoint
-- Never an exception lengthened or made open-ended.
CREATE TRIGGER `policy_exceptions_removed_app_update` BEFORE UPDATE ON `policy_exceptions`
WHEN (NEW.`until` IS NULL OR (OLD.`until` IS NOT NULL AND NEW.`until` > OLD.`until`)) AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'policy_exceptions: takes nothing new for a removed App');
END;
