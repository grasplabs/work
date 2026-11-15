CREATE TABLE `removed_sources` (
	`source` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`version_row` integer,
	FOREIGN KEY (`version_row`) REFERENCES `source_versions`(`row`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `removed_sources_version_row_unique` ON `removed_sources` (`version_row`);--> statement-breakpoint
CREATE INDEX `removed_sources_subject_idx` ON `removed_sources` (`subject`);