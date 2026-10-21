-- Candidates: frozen versions of an App on their way to being made
-- current, and their verification reports (src/app-candidates.ts, GRA-394).
CREATE TABLE `app_candidate_reports` (
	`candidate_id` text PRIMARY KEY NOT NULL,
	`report` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `app_candidates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `app_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`version` integer NOT NULL,
	`source_tree` text NOT NULL,
	`based_on` integer NOT NULL,
	`previous_candidate` text,
	`state` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`lease` text,
	`lease_until` integer,
	`outcome` text,
	`report_hash` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_candidates_open_idx` ON `app_candidates` (`app_id`,`version`,`based_on`) WHERE "app_candidates"."state" IN ('frozen', 'checking', 'building', 'verifying', 'verified');--> statement-breakpoint
CREATE INDEX `app_candidates_app_idx` ON `app_candidates` (`app_id`,`created_at`);
--> statement-breakpoint
-- A report is written once and never changes (spec 22.1: a verified
-- snapshot is never mutated).
CREATE TRIGGER `app_candidate_reports_no_update` BEFORE UPDATE ON `app_candidate_reports`
BEGIN
	SELECT RAISE(ABORT, 'app_candidate_reports never change');
END;--> statement-breakpoint
CREATE TRIGGER `app_candidate_reports_no_delete` BEFORE DELETE ON `app_candidate_reports`
BEGIN
	SELECT RAISE(ABORT, 'app_candidate_reports never change');
END;--> statement-breakpoint
-- A candidate pins what it is of, and its report once it has one.
CREATE TRIGGER `app_candidates_pinned` BEFORE UPDATE OF `id`, `app_id`, `version`, `source_tree`, `based_on`, `previous_candidate`, `created_by`, `created_at`, `report_hash` ON `app_candidates`
WHEN NEW.`id` IS NOT OLD.`id`
	OR NEW.`app_id` IS NOT OLD.`app_id`
	OR NEW.`version` IS NOT OLD.`version`
	OR NEW.`source_tree` IS NOT OLD.`source_tree`
	OR NEW.`based_on` IS NOT OLD.`based_on`
	OR NEW.`previous_candidate` IS NOT OLD.`previous_candidate`
	OR NEW.`created_by` IS NOT OLD.`created_by`
	OR NEW.`created_at` IS NOT OLD.`created_at`
	OR (OLD.`report_hash` IS NOT NULL AND NEW.`report_hash` IS NOT OLD.`report_hash`)
BEGIN
	SELECT RAISE(ABORT, 'app_candidates pin what they are of');
END;--> statement-breakpoint
-- A candidate only moves forward, one stage at a time, or ends in an
-- outcome while it is open; once active or ended it never moves again.
CREATE TRIGGER `app_candidates_moves` BEFORE UPDATE OF `state` ON `app_candidates`
WHEN NEW.`state` IS NOT OLD.`state` AND NOT (
	(OLD.`state` = 'frozen' AND NEW.`state` = 'checking')
	OR (OLD.`state` = 'checking' AND NEW.`state` = 'building')
	OR (OLD.`state` = 'building' AND NEW.`state` = 'verifying')
	OR (OLD.`state` = 'verifying' AND NEW.`state` = 'verified')
	OR (OLD.`state` = 'verified' AND NEW.`state` = 'active')
	OR (OLD.`state` IN ('frozen', 'checking', 'building', 'verifying', 'verified')
		AND NEW.`state` IN ('repairable_failed', 'operationally_blocked', 'rejected', 'superseded'))
)
BEGIN
	SELECT RAISE(ABORT, 'app_candidates move forward only');
END;--> statement-breakpoint
-- Verified and active hold a report, stored before, under the hash pinned.
CREATE TRIGGER `app_candidates_reported` BEFORE UPDATE OF `state` ON `app_candidates`
WHEN NEW.`state` IN ('verified', 'active') AND (NEW.`report_hash` IS NULL
	OR NOT EXISTS (SELECT 1 FROM `app_candidate_reports`
		WHERE `candidate_id` = NEW.`id` AND `hash` = NEW.`report_hash`))
BEGIN
	SELECT RAISE(ABORT, 'app_candidates are verified only with their report');
END;--> statement-breakpoint
-- A candidate is created frozen, and never deleted.
CREATE TRIGGER `app_candidates_created_frozen` BEFORE INSERT ON `app_candidates`
WHEN NEW.`state` IS NOT 'frozen' OR NEW.`report_hash` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'app_candidates start frozen');
END;--> statement-breakpoint
CREATE TRIGGER `app_candidates_no_delete` BEFORE DELETE ON `app_candidates`
BEGIN
	SELECT RAISE(ABORT, 'app_candidates are kept');
END;
