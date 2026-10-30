ALTER TABLE `brain_eval_suite_versions` ADD `decision` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- The decision policy is frozen with the version, as its digests are.
DROP TRIGGER `brain_eval_suite_versions_frozen`;--> statement-breakpoint
CREATE TRIGGER `brain_eval_suite_versions_frozen` BEFORE UPDATE OF `development_digest`, `validation_digest`, `final_digest`, `grader`, `grader_digest`, `pins`, `decision`, `proposed_by`, `owner_id` ON `brain_eval_suite_versions`
BEGIN
  SELECT RAISE(ABORT, 'a suite version''s digests, grader, pins, decision and owner are never updated');
END;