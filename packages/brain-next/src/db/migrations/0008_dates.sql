CREATE TABLE `chunk_days` (
	`chunk` integer NOT NULL,
	`year` integer NOT NULL,
	`monthday` integer NOT NULL,
	PRIMARY KEY(`chunk`, `year`, `monthday`),
	FOREIGN KEY (`chunk`) REFERENCES `chunks`(`row`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chunk_days_day_idx` ON `chunk_days` (`monthday`,`year`,`chunk`);--> statement-breakpoint
-- A chunk's days go with it, as its words and stems do (0006): before
-- the chunk, so the foreign key never sees a day without its chunk. The
-- chunks already stored get their days from the word index's rebuild,
-- which `wordsVersion` 3 (words.ts) starts.
CREATE TRIGGER `chunks_days_delete` BEFORE DELETE ON `chunks` BEGIN
	DELETE FROM `chunk_days` WHERE `chunk` = OLD.`row`;
END;
