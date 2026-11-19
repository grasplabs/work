CREATE TABLE `source_reader_pairs` (
	`place` text NOT NULL,
	`principal` text NOT NULL,
	PRIMARY KEY(`place`, `principal`)
);
--> statement-breakpoint
CREATE INDEX `source_reader_pairs_principal_idx` ON `source_reader_pairs` (`principal`,`place`);