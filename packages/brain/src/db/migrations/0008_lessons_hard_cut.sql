-- Lessons written before a version kept its episode count (`episodes`) are
-- dropped, never read through a compatibility path (hard cut): every scope
-- with episodes is consolidated again from its first, in the new shape.
DELETE FROM `brain_lesson_evidence`;--> statement-breakpoint
DELETE FROM `brain_lesson_versions`;--> statement-breakpoint
DELETE FROM `brain_lessons`;--> statement-breakpoint
DELETE FROM `brain_consolidation_marks`;--> statement-breakpoint
INSERT OR IGNORE INTO `brain_consolidation_due` (`scope_key`, `scope`, `scope_id`, `since`, `touched_at`)
SELECT DISTINCT 'person:' || `owner_id`, 'person', `owner_id`, 0, 0 FROM `brain_episodes` WHERE `scope` = 'person'
UNION
SELECT DISTINCT 'session:' || `audience`, 'session', `audience`, 0, 0 FROM `brain_episodes` WHERE `scope` = 'session' AND `audience` IS NOT NULL;
