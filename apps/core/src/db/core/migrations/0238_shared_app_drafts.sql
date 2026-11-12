CREATE TABLE `app_draft_contents` (
	`app_id` text NOT NULL,
	`sha256` text NOT NULL,
	`content` text NOT NULL,
	PRIMARY KEY(`app_id`, `sha256`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `app_draft_files` (
	`app_id` text NOT NULL,
	`path` text NOT NULL,
	`content` text,
	PRIMARY KEY(`app_id`, `path`),
	FOREIGN KEY (`app_id`) REFERENCES `app_drafts`(`app_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `app_draft_point_files` (
	`app_id` text NOT NULL,
	`number` integer NOT NULL,
	`path` text NOT NULL,
	`sha256` text,
	PRIMARY KEY(`app_id`, `number`, `path`)
);
--> statement-breakpoint
CREATE INDEX `app_draft_point_files_content` ON `app_draft_point_files` (`app_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `app_draft_points` (
	`app_id` text NOT NULL,
	`number` integer NOT NULL,
	`revision` integer NOT NULL,
	`base` integer,
	`definition` text,
	`content_hash` text NOT NULL,
	`person_id` text NOT NULL,
	`chat_id` text,
	`turn_id` text,
	`call_id` text,
	`restored_from` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `number`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `app_draft_points_chat` ON `app_draft_points` (`chat_id`,`turn_id`);--> statement-breakpoint
CREATE TABLE `app_drafts` (
	`app_id` text PRIMARY KEY NOT NULL,
	`base` integer,
	`revision` integer NOT NULL,
	`definition` text,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `app_versions` ADD `label` text;--> statement-breakpoint
CREATE UNIQUE INDEX `app_versions_label` ON `app_versions` (`app_id`,`label`);--> statement-breakpoint
ALTER TABLE `apps` ADD `live_label` text;--> statement-breakpoint
ALTER TABLE `apps` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `apps` ADD `archived_by` text;--> statement-breakpoint
-- Each App stays as closed as its status had it, now that whom it is open
-- to is `current_version` and `archived_at` (src/app-access.ts): one
-- archived is archived when and by whom its status said; a draft with a
-- version current, open to its builders alone until now, is archived too,
-- for a builder to restore. Its status stays, for a roll back to the
-- release before. Before `apps_removed_kept` covers these columns below,
-- so a removed App is carried too.
UPDATE `apps` SET
	`archived_at` = coalesce(`status_changed_at`, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
	`archived_by` = `status_changed_by`
WHERE `status` = 'archived' OR (`status` = 'draft' AND `current_version` IS NOT NULL);--> statement-breakpoint
-- An App's one shared draft and its undo points (src/app-drafts.ts) take
-- nothing new for a removed App, as its other rows don't (migration 0170).
CREATE TRIGGER `app_drafts_removed_app_insert` BEFORE INSERT ON `app_drafts`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_drafts: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `app_draft_files_removed_app_insert` BEFORE INSERT ON `app_draft_files`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_draft_files: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `app_draft_points_removed_app_insert` BEFORE INSERT ON `app_draft_points`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_draft_points: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `app_draft_point_files_removed_app_insert` BEFORE INSERT ON `app_draft_point_files`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_draft_point_files: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `app_draft_contents_removed_app_insert` BEFORE INSERT ON `app_draft_contents`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_draft_contents: takes nothing new for a removed App');
END;
--> statement-breakpoint
-- The App's own row: what it is and whom it reaches never changes once
-- removed, as migration 0170 had it, over the columns of both releases:
-- when it was archived, and its live version's label, too.
DROP TRIGGER `apps_removed_kept`;--> statement-breakpoint
CREATE TRIGGER `apps_removed_kept` BEFORE UPDATE OF `archived_at`, `archived_by`, `status`, `status_changed_at`, `status_changed_by`, `removed_at`, `removed_by`, `owner_id`, `blueprint`, `current_version`, `live_label`, `pending_version`, `responsible_id`, `audience_type`, `audience_id` ON `apps`
WHEN OLD.`removed_at` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'apps: a removed App stays as it was removed');
END;
