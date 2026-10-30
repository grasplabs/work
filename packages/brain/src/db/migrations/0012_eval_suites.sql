CREATE TABLE `brain_eval_cases` (
	`suite_id` text NOT NULL,
	`version` integer NOT NULL,
	`case_id` text NOT NULL,
	`split` text NOT NULL,
	`family` text NOT NULL,
	`group` text NOT NULL,
	`source` text NOT NULL,
	`input` text NOT NULL,
	`expected` text NOT NULL,
	PRIMARY KEY(`suite_id`, `version`, `case_id`)
);
--> statement-breakpoint
CREATE INDEX `brain_eval_cases_split_idx` ON `brain_eval_cases` (`suite_id`,`version`,`split`);--> statement-breakpoint
CREATE TABLE `brain_eval_suite_versions` (
	`suite_id` text NOT NULL,
	`version` integer NOT NULL,
	`revision` integer NOT NULL,
	`owner_id` text NOT NULL,
	`next_owner_id` text,
	`name` text NOT NULL,
	`state` text DEFAULT 'proposed' NOT NULL,
	`development_digest` text NOT NULL,
	`validation_digest` text NOT NULL,
	`final_digest` text NOT NULL,
	`grader` text NOT NULL,
	`grader_digest` text NOT NULL,
	`pins` text NOT NULL,
	`proposed_by` text NOT NULL,
	`accepted_by` text,
	`accepted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`suite_id`, `version`)
);--> statement-breakpoint
-- A suite version's cases, digests, grader, pins, proposer and owner are
-- never changed in place (eval-suites.ts): a change is a new version.
CREATE TRIGGER `brain_eval_cases_frozen` BEFORE UPDATE ON `brain_eval_cases`
BEGIN
  SELECT RAISE(ABORT, 'brain_eval_cases are never updated');
END;--> statement-breakpoint
CREATE TRIGGER `brain_eval_suite_versions_frozen` BEFORE UPDATE OF `development_digest`, `validation_digest`, `final_digest`, `grader`, `grader_digest`, `pins`, `proposed_by`, `owner_id` ON `brain_eval_suite_versions`
BEGIN
  SELECT RAISE(ABORT, 'a suite version''s digests, grader, pins and owner are never updated');
END;--> statement-breakpoint
-- A version's case set is fixed once the version is written: its cases go
-- in before it in the proposal's batch, and none is added or taken after.
CREATE TRIGGER `brain_eval_cases_added_late` BEFORE INSERT ON `brain_eval_cases`
WHEN EXISTS (SELECT 1 FROM `brain_eval_suite_versions` WHERE `suite_id` = NEW.`suite_id` AND `version` = NEW.`version`)
BEGIN
  SELECT RAISE(ABORT, 'a suite version''s cases are never added to');
END;--> statement-breakpoint
CREATE TRIGGER `brain_eval_cases_kept` BEFORE DELETE ON `brain_eval_cases`
BEGIN
  SELECT RAISE(ABORT, 'brain_eval_cases are never deleted');
END;
