CREATE TABLE `run_brain_evidence` (
	`run_id` text NOT NULL,
	`document_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`version` integer NOT NULL,
	`pinned` text NOT NULL,
	`permission_id` text NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `document_id`, `version`, `permission_id`)
);
