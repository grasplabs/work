ALTER TABLE `app_origins` ADD `definition` text;--> statement-breakpoint
ALTER TABLE `app_versions` ADD `definition` text;--> statement-breakpoint
ALTER TABLE `app_versions` ADD `definition_hash` text;--> statement-breakpoint
ALTER TABLE `blueprints` ADD `definition` text;--> statement-breakpoint
-- A version's definition is written with it and never changed, as its
-- tree never is (src/apps.ts): its sealed release names its hash.
CREATE TRIGGER `app_versions_definition_immutable` BEFORE UPDATE OF `definition`, `definition_hash` ON `app_versions`
WHEN NEW.`definition` IS NOT OLD.`definition`
	OR NEW.`definition_hash` IS NOT OLD.`definition_hash`
BEGIN
	SELECT RAISE(ABORT, 'A version''s definition never changes');
END;
