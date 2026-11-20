CREATE TABLE `brain_default_reads` (
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`first_read_at` integer NOT NULL,
	PRIMARY KEY(`subject_type`, `subject_id`)
);
