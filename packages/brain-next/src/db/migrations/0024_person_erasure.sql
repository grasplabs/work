CREATE TABLE `person_erasure_memories` (
	`memory` integer PRIMARY KEY NOT NULL,
	`erasure` text NOT NULL,
	FOREIGN KEY (`memory`) REFERENCES `memories`(`row`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `person_erasure_subjects` (
	`subject` text PRIMARY KEY NOT NULL,
	`erasure` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `person_erasure_subjects_erasure_idx` ON `person_erasure_subjects` (`erasure`);