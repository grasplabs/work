-- Secure deletes in the full-text index (src/knowledge/search-erasure.ts,
-- threat model in GRA-693): every delete of a row, a save's or a purge's,
-- takes its terms out of the index's pages in its own transaction, rather
-- than leaving them there, unfindable, until a merge. A content purge then
-- needs no rebuild of the whole index, only a check of its terms.
--
-- Turned on with a rebuild, so the index holds no terms of rows deleted
-- before: whoever sees secure deletes on sees a clean index. The first
-- secure delete raises the index's FTS5 format version, which SQLite
-- before 3.42 can't read; D1 and workerd ship a newer one.
INSERT INTO `search_words` (`search_words`, `rank`) VALUES ('secure-delete', 1);
--> statement-breakpoint
INSERT INTO `search_trigrams` (`search_trigrams`, `rank`) VALUES ('secure-delete', 1);
--> statement-breakpoint
INSERT INTO `search_words` (`search_words`) VALUES ('rebuild');
--> statement-breakpoint
INSERT INTO `search_trigrams` (`search_trigrams`) VALUES ('rebuild');
