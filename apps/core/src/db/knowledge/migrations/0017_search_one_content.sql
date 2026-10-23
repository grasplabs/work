-- One copy of the indexed text for both search indexes (GRA-697). The
-- trigram index becomes an FTS5 external-content table over the words
-- index's own content (`search_words_content`, columns `c0`..`c3`: title,
-- description, headings, text), instead of keeping a second copy of the
-- same rows. FTS5 can't name another FTS5 table as its content, only a
-- table, so it names that table; `content_rowid` is its `id`.
--
-- An external-content index is kept by hand (sqlite.org/fts5.html, 4.4.3):
-- a row is indexed after the words index holds it, and deleted from the
-- trigram index first, while its content is still there to tokenize
-- (4.4.4.1); a delete with the content gone would leave its tokens in the
-- index. Search reads columns by position, so their names don't matter.
--
-- Secure deletes stay on (0011_search_secure_delete.sql), turned on before
-- the rebuild that indexes every row.
DROP TRIGGER `sections_search_insert`;
--> statement-breakpoint
DROP TRIGGER `sections_search_delete`;
--> statement-breakpoint
DROP TABLE `search_trigrams`;
--> statement-breakpoint
CREATE VIRTUAL TABLE `search_trigrams` USING fts5(
	c0, c1, c2, c3,
	content = 'search_words_content',
	content_rowid = 'id',
	tokenize = 'trigram remove_diacritics 1'
);
--> statement-breakpoint
INSERT INTO `search_trigrams` (`search_trigrams`, `rank`) VALUES ('secure-delete', 1);
--> statement-breakpoint
INSERT INTO `search_trigrams` (`search_trigrams`) VALUES ('rebuild');
--> statement-breakpoint
CREATE TRIGGER `sections_search_insert` AFTER INSERT ON `sections` BEGIN
	INSERT INTO `search_rows` (`document_id`, `position`)
	VALUES (new.`document_id`, new.`position`);
	INSERT INTO `search_words` (rowid, title, description, headings, text)
	SELECT r.`id`, d.`title`, d.`description`,
		(SELECT group_concat(value, ' ') FROM json_each(new.`headings`)), new.`text`
	FROM `search_rows` r
	JOIN `documents` d ON d.`id` = r.`document_id`
	WHERE r.`document_id` = new.`document_id` AND r.`position` = new.`position`;
	INSERT INTO `search_trigrams` (rowid, c0, c1, c2, c3)
	SELECT w.rowid, w.title, w.description, w.headings, w.text
	FROM `search_words` w
	WHERE w.rowid = (
		SELECT `id` FROM `search_rows`
		WHERE `document_id` = new.`document_id` AND `position` = new.`position`
	);
END;
--> statement-breakpoint
CREATE TRIGGER `sections_search_delete` AFTER DELETE ON `sections` BEGIN
	DELETE FROM `search_trigrams` WHERE rowid = (
		SELECT `id` FROM `search_rows`
		WHERE `document_id` = old.`document_id` AND `position` = old.`position`
	);
	DELETE FROM `search_words` WHERE rowid = (
		SELECT `id` FROM `search_rows`
		WHERE `document_id` = old.`document_id` AND `position` = old.`position`
	);
	DELETE FROM `search_rows`
	WHERE `document_id` = old.`document_id` AND `position` = old.`position`;
END;
