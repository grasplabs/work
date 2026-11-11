-- The words of every source, for recall (recall.ts): its text as search
-- reads it (words.ts `foldForSearch`), written by the store in the same
-- transaction as the source, while `sources` keeps the text whole as
-- given. The tokenizer is today's Brain's; folding already removed case
-- and accents, so it only cuts the text into words.
CREATE VIRTUAL TABLE `source_words` USING fts5(
	text,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `sources_words_delete` AFTER DELETE ON `sources` BEGIN
	DELETE FROM `source_words` WHERE rowid = OLD.`row`;
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
