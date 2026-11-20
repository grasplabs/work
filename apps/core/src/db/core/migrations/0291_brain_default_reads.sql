CREATE TABLE `brain_default_reads` (
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`first_read_at` integer NOT NULL,
	PRIMARY KEY(`subject_type`, `subject_id`)
);--> statement-breakpoint
CREATE TRIGGER `brain_default_reads_removed_app_insert` BEFORE INSERT ON `brain_default_reads`
WHEN NEW.`subject_type` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`subject_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'brain_default_reads: takes nothing new for a removed App');
END;
