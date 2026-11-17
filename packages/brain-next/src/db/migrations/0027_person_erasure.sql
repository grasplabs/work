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
CREATE INDEX `person_erasure_subjects_erasure_idx` ON `person_erasure_subjects` (`erasure`);--> statement-breakpoint
CREATE TABLE `restore_cards` (
	`subject` text NOT NULL,
	`entity` text NOT NULL,
	PRIMARY KEY(`subject`, `entity`)
);
--> statement-breakpoint
CREATE INDEX `memories_speaker_idx` ON `memories` ((speaker ->> 'person')) WHERE speaker ->> 'kind' = 'internal';--> statement-breakpoint
CREATE INDEX `memory_confirmations_person_idx` ON `memory_confirmations` (`person`);