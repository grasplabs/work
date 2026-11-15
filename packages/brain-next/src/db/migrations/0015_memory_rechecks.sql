CREATE TABLE `memory_rechecked` (
	`source` text NOT NULL,
	`through` integer NOT NULL,
	`subject` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`source`, `through`)
);
--> statement-breakpoint
CREATE INDEX `memory_rechecked_subject_idx` ON `memory_rechecked` (`subject`,`through`);--> statement-breakpoint
CREATE TABLE `memory_rechecks` (
	`memory` integer NOT NULL,
	`source` text NOT NULL,
	`version` integer NOT NULL,
	`subject` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`memory`, `version`),
	FOREIGN KEY (`memory`) REFERENCES `memories`(`row`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `memory_rechecks_version_idx` ON `memory_rechecks` (`source`,`version`);--> statement-breakpoint
CREATE INDEX `memory_rechecks_subject_idx` ON `memory_rechecks` (`subject`,`version`);--> statement-breakpoint
CREATE INDEX `memories_source_idx` ON `memories` (`source`);