-- The words of every source, for recall (recall.ts): whole words, case and
-- diacritics folded ("financiele" finds "financiële"), the tokenizer
-- today's Brain searches with. External content: the text is kept once, in
-- `sources`, and triggers keep the index in step with it.
CREATE VIRTUAL TABLE `source_words` USING fts5(
	text,
	content = 'sources',
	content_rowid = 'row',
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `sources_words_insert` AFTER INSERT ON `sources` BEGIN
	INSERT INTO `source_words` (rowid, text) VALUES (NEW.`row`, NEW.`text`);
END;
--> statement-breakpoint
CREATE TRIGGER `sources_words_delete` AFTER DELETE ON `sources` BEGIN
	INSERT INTO `source_words` (`source_words`, rowid, text) VALUES ('delete', OLD.`row`, OLD.`text`);
END;
--> statement-breakpoint
-- A source is added, never changed: a new version is a new row.
CREATE TRIGGER `sources_no_update` BEFORE UPDATE ON `sources` BEGIN
	SELECT RAISE(ABORT, 'sources are added, never updated');
END;
--> statement-breakpoint
-- A set of readers is written once, never changed: every item pointing at
-- it would change its readers with it.
CREATE TRIGGER `reader_sets_no_update` BEFORE UPDATE ON `reader_sets` BEGIN
	SELECT RAISE(ABORT, 'reader sets are written once, never updated');
END;
--> statement-breakpoint
CREATE TRIGGER `reader_set_members_no_update` BEFORE UPDATE ON `reader_set_members` BEGIN
	SELECT RAISE(ABORT, 'reader sets are written once, never updated');
END;
