-- The search index follows sections through triggers (0001_search.sql),
-- and INSERT OR REPLACE over a section's key, or over its implicit rowid,
-- deletes the old row without firing `sections_search_delete` (recursive
-- triggers are off), leaving its search row behind for a section that is
-- gone. A save deletes a document's sections before inserting the new
-- ones (knowledge/documents.ts), so no insert ever meets a row it would
-- replace: one that does is refused, as SQLite's own unique violation.
-- An insert that names no rowid has NEW.rowid -1 here, which no row has.
CREATE TRIGGER `sections_insert_key` BEFORE INSERT ON `sections`
WHEN EXISTS (
	SELECT 1 FROM `sections`
	WHERE `document_id` = NEW.`document_id` AND `position` = NEW.`position`
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: sections.document_id, sections.position (sections are deleted before they are written again)');
END;
--> statement-breakpoint
CREATE TRIGGER `sections_insert_rowid` BEFORE INSERT ON `sections`
WHEN EXISTS (
	SELECT 1 FROM `sections` WHERE rowid = NEW.rowid
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: sections.rowid (sections are deleted before they are written again)');
END;
