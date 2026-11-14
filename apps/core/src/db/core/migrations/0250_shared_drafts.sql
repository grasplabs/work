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
ALTER TABLE `workflow_resource_versions` ADD `label` text;--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_resource_versions_label` ON `workflow_resource_versions` (`workflow_resource_id`,`label`);--> statement-breakpoint
-- An approval serves every version declaring its binding
-- (src/workflow-bindings.ts): of the active approvals of one binding,
-- given each for a version of its own, the newest stays and serves them
-- all; the rest are revoked, as approving it again would have.
UPDATE `workflow_binding_approvals` SET `status` = 'revoked', `revoked_by` = `approved_by`, `revoked_at` = `approved_at`
WHERE `status` = 'active' AND EXISTS (SELECT 1 FROM `workflow_binding_approvals` AS `newer`
  WHERE `newer`.`workflow_resource_id` = `workflow_binding_approvals`.`workflow_resource_id`
    AND `newer`.`alias` = `workflow_binding_approvals`.`alias`
    AND `newer`.`kind` = `workflow_binding_approvals`.`kind`
    AND `newer`.`contract_id` = `workflow_binding_approvals`.`contract_id`
    AND `newer`.`fingerprint` = `workflow_binding_approvals`.`fingerprint`
    AND `newer`.`status` = 'active'
    AND (`newer`.`approved_at` > `workflow_binding_approvals`.`approved_at`
      OR (`newer`.`approved_at` = `workflow_binding_approvals`.`approved_at` AND `newer`.`id` > `workflow_binding_approvals`.`id`)));--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_binding_approvals_binding_idx` ON `workflow_binding_approvals` (`workflow_resource_id`,`alias`,`kind`,`contract_id`,`fingerprint`) WHERE "workflow_binding_approvals"."status" = 'active';--> statement-breakpoint
-- Drafts start empty, Apps' and workflows' alike: nothing is copied from
-- `app_drafts` or `workflow_resource_drafts`, which stay unused for the
-- release before (expand, then contract).
--
-- A workflow version stays as it was written but for its label, given the
-- first time it goes live (src/workflow-publish.ts): the trigger that
-- refused every update refuses an update of any other column.
DROP TRIGGER `workflow_resource_versions_immutable_update`;--> statement-breakpoint
CREATE TRIGGER `workflow_resource_versions_immutable_update` BEFORE UPDATE OF `workflow_resource_id`, `version`, `definition_version`, `definition`, `definition_json_hash`, `profile_version`, `evaluator_hash`, `contract`, `contract_hash`, `manifest`, `manifest_hash`, `author_id`, `created_at`, `seal_id` ON `workflow_resource_versions`
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
