CREATE TABLE `person_erasure_events` (
	`erasure` text NOT NULL,
	`who` text NOT NULL,
	`key_id` text NOT NULL,
	PRIMARY KEY(`erasure`, `who`)
);
