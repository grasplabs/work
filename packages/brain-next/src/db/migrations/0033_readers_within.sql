CREATE TABLE `reader_set_readers` (
	`reader_set` integer NOT NULL,
	`principal` text NOT NULL,
	PRIMARY KEY(`reader_set`, `principal`),
	FOREIGN KEY (`reader_set`) REFERENCES `reader_sets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reader_set_readers_principal_idx` ON `reader_set_readers` (`principal`,`reader_set`);--> statement-breakpoint
ALTER TABLE `reader_sets` ADD `within` text;--> statement-breakpoint
-- A set of readers within a group is written once, never changed, as
-- every set is (0001_words): every item pointing at it would change its
-- readers with it.
CREATE TRIGGER `reader_set_readers_no_update` BEFORE UPDATE ON `reader_set_readers` BEGIN
	SELECT RAISE(ABORT, 'reader sets are written once, never updated');
END;
