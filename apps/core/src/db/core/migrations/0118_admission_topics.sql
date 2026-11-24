CREATE TABLE `admission_topics` (
	`id` text NOT NULL,
	`revision` integer NOT NULL,
	`name` text NOT NULL,
	`coverage` text NOT NULL,
	`examples` text NOT NULL,
	`owner` text NOT NULL,
	`effective_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`id`, `revision`)
);

--> statement-breakpoint
-- A revision never changes once written (schema.ts): a change is the next
-- revision, and an edit that tried to rewrite one fails.
CREATE TRIGGER `admission_topics_immutable` BEFORE UPDATE ON `admission_topics`
BEGIN
	SELECT RAISE(ABORT, 'admission_topics revisions never change');
END;
