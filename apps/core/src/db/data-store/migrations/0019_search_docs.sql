CREATE TABLE `sdk_search_docs` (
	`doc` integer PRIMARY KEY NOT NULL,
	`doc_table` text NOT NULL,
	`doc_record` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sdk_search_docs_record` ON `sdk_search_docs` (`doc_table`,`doc_record`);--> statement-breakpoint
CREATE TRIGGER `sdk_search_docs_gone` AFTER DELETE ON `sdk_records` BEGIN
	DELETE FROM `sdk_search_docs` WHERE `doc_table` = old.`table_id` AND `doc_record` = old.`record_id`;
END;