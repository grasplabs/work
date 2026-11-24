CREATE TABLE `extractors` (
	`row` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`read_prompt` text NOT NULL,
	`read_model` text NOT NULL,
	`check_prompt` text NOT NULL,
	`check_model` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `extractors_calls_unique` ON `extractors` (`read_prompt`,`read_model`,`check_prompt`,`check_model`);--> statement-breakpoint
ALTER TABLE `memories` ADD `extractor` integer REFERENCES extractors(row);