-- The words of every source, for recall (recall.ts): its text as search
-- reads it (words.ts `foldForSearch`), written by the store in the same
-- transaction as the source, while `sources` keeps the text whole as
-- given. Contentless: the index keeps no copy of the text, only which
-- rows hold which words, since recall reads nothing back but the rowid;
-- `contentless_delete` lets a row be deleted by its rowid. The tokenizer
-- is today's Brain's, with marks counted as part of a word (words.ts
-- `wordPattern`: the same categories), so a Devanagari or Thai word isn't
-- cut at its vowel signs; folding already removed case and accents.
CREATE VIRTUAL TABLE `source_words` USING fts5(
	text,
	content = '',
	contentless_delete = 1,
	tokenize = 'unicode61 remove_diacritics 2 categories ''L* N* Co M*'''
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
