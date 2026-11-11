-- The stems of every chunk's words, beside its words as written
-- (`chunk_words`, 0002), for recall (recall.ts): the distinct stems the
-- five languages' Snowball stemmers give the chunk's words, besides the
-- words themselves (words.ts `indexedOf`). The store writes it in the same
-- transaction as the chunk. Contentless with deletes, as `chunk_words`:
-- recall reads back only the rowid, and a deleted chunk is out of both
-- indexes' answers at once. (Its terms stay in their pages until FTS5
-- merges them away: GRA-1729.) The tokenizer is `chunk_words`' own; it
-- only splits what words.ts already cut into words.
CREATE VIRTUAL TABLE `chunk_stems` USING fts5(
	stems,
	content = '',
	contentless_delete = 1,
	tokenize = 'unicode61 remove_diacritics 2 categories ''L* N* Co M*'''
);
--> statement-breakpoint
CREATE TRIGGER `chunks_stems_delete` AFTER DELETE ON `chunks` BEGIN
	DELETE FROM `chunk_stems` WHERE rowid = OLD.`row`;
END;
