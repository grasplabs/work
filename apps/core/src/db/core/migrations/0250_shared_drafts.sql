CREATE TABLE `draft_blobs` (
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`sha256` text NOT NULL,
	`content` text NOT NULL,
	PRIMARY KEY(`subject_kind`, `subject_id`, `sha256`)
);
--> statement-breakpoint
CREATE TABLE `draft_checkpoint_files` (
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`number` integer NOT NULL,
	`path` text NOT NULL,
	`sha256` text,
	PRIMARY KEY(`subject_kind`, `subject_id`, `number`, `path`)
);
--> statement-breakpoint
CREATE INDEX `draft_checkpoint_files_content` ON `draft_checkpoint_files` (`subject_kind`,`subject_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `draft_checkpoints` (
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
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
	PRIMARY KEY(`subject_kind`, `subject_id`, `number`)
);
--> statement-breakpoint
CREATE INDEX `draft_checkpoints_chat` ON `draft_checkpoints` (`chat_id`,`turn_id`);--> statement-breakpoint
CREATE TABLE `draft_files` (
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`path` text NOT NULL,
	`content` text,
	PRIMARY KEY(`subject_kind`, `subject_id`, `path`)
);
--> statement-breakpoint
CREATE TABLE `drafts` (
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`base` integer,
	`revision` integer NOT NULL,
	`definition` text,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	PRIMARY KEY(`subject_kind`, `subject_id`)
);
--> statement-breakpoint
ALTER TABLE `workflow_resource_versions` ADD `contract_version` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_resource_versions` ADD `label` text;--> statement-breakpoint
ALTER TABLE `workflow_resource_versions` ADD `status` text;--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_resource_versions_label` ON `workflow_resource_versions` (`workflow_resource_id`,`label`);--> statement-breakpoint
-- Every App's draft and its undo points move into the drafts every
-- subject shares (src/drafts.ts), as they are: an App's undo points are
-- its draft's checkpoints. The App tables stay, unread, for the release
-- before (expand, then contract).
INSERT INTO `drafts` (`subject_kind`, `subject_id`, `base`, `revision`, `definition`, `updated_at`, `updated_by`)
SELECT 'app', `app_id`, `base`, `revision`, `definition`, `updated_at`, `updated_by` FROM `app_drafts`;--> statement-breakpoint
INSERT INTO `draft_files` (`subject_kind`, `subject_id`, `path`, `content`)
SELECT 'app', `app_id`, `path`, `content` FROM `app_draft_files`;--> statement-breakpoint
INSERT INTO `draft_checkpoints` (`subject_kind`, `subject_id`, `number`, `revision`, `base`, `definition`, `content_hash`, `person_id`, `chat_id`, `turn_id`, `call_id`, `restored_from`, `created_at`)
SELECT 'app', `app_id`, `number`, `revision`, `base`, `definition`, `content_hash`, `person_id`, `chat_id`, `turn_id`, `call_id`, `restored_from`, `created_at` FROM `app_draft_points`;--> statement-breakpoint
INSERT INTO `draft_checkpoint_files` (`subject_kind`, `subject_id`, `number`, `path`, `sha256`)
SELECT 'app', `app_id`, `number`, `path`, `sha256` FROM `app_draft_point_files`;--> statement-breakpoint
INSERT INTO `draft_blobs` (`subject_kind`, `subject_id`, `sha256`, `content`)
SELECT 'app', `app_id`, `sha256`, `content` FROM `app_draft_contents`;--> statement-breakpoint
-- A workflow version stays as it was written but for its label, given
-- the first time it goes live (src/workflow-publish.ts): the trigger that
-- refused every update refuses an update of any other column, the
-- contract version filled in here first.
DROP TRIGGER `workflow_resource_versions_immutable_update`;--> statement-breakpoint
-- A workflow version's contract version is what its definition version
-- was: the code reads the new column alone.
UPDATE `workflow_resource_versions` SET `contract_version` = `definition_version`;--> statement-breakpoint
CREATE TRIGGER `workflow_resource_versions_immutable_update` BEFORE UPDATE OF `workflow_resource_id`, `version`, `definition_version`, `definition`, `definition_json_hash`, `profile_version`, `evaluator_hash`, `contract`, `contract_hash`, `manifest`, `manifest_hash`, `author_id`, `created_at`, `seal_id`, `contract_version`, `status` ON `workflow_resource_versions`
BEGIN
	SELECT RAISE(ABORT, 'workflow_resource_versions are immutable');
END;
--> statement-breakpoint
-- A removed App's draft takes nothing new, as its App tables didn't
-- (migration 0238).
CREATE TRIGGER `drafts_removed_app_insert` BEFORE INSERT ON `drafts`
WHEN NEW.`subject_kind` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`subject_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'drafts: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `draft_files_removed_app_insert` BEFORE INSERT ON `draft_files`
WHEN NEW.`subject_kind` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`subject_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'draft_files: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `draft_checkpoints_removed_app_insert` BEFORE INSERT ON `draft_checkpoints`
WHEN NEW.`subject_kind` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`subject_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'draft_checkpoints: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `draft_checkpoint_files_removed_app_insert` BEFORE INSERT ON `draft_checkpoint_files`
WHEN NEW.`subject_kind` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`subject_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'draft_checkpoint_files: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `draft_blobs_removed_app_insert` BEFORE INSERT ON `draft_blobs`
WHEN NEW.`subject_kind` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`subject_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'draft_blobs: takes nothing new for a removed App');
END;
