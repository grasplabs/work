CREATE TABLE `chunk_blocks` (
	`reader_set` integer NOT NULL,
	`block` integer NOT NULL,
	PRIMARY KEY(`reader_set`, `block`)
);
--> statement-breakpoint
CREATE INDEX `chunk_blocks_block_idx` ON `chunk_blocks` (`block`);--> statement-breakpoint
CREATE INDEX `chunk_days_day_chunk_idx` ON `chunk_days` (`month_day`,`chunk`);--> statement-breakpoint
-- Every chunk added, by this release or any other (an older one after a
-- rollback, which places its chunks after the last row), is in a block of
-- its version's set of readers, 1,048,576 rows a block (chunk-blocks.ts
-- `chunkBlockRows`): recall reads a reader's chunks only within their
-- blocks, so a chunk outside them would never be found.
CREATE TRIGGER `chunks_block_insert` AFTER INSERT ON `chunks` BEGIN
	INSERT OR IGNORE INTO `chunk_blocks` (`reader_set`, `block`)
	SELECT `reader_set`, NEW.`row` / 1048576 FROM `source_versions`
	WHERE `row` = NEW.`version_row`;
END;
--> statement-breakpoint
-- The chunks already stored, each in the block its row is in.
INSERT OR IGNORE INTO `chunk_blocks` (`reader_set`, `block`)
SELECT DISTINCT `source_versions`.`reader_set`, `chunks`.`row` / 1048576
FROM `chunks`
JOIN `source_versions` ON `source_versions`.`row` = `chunks`.`version_row`;
