CREATE TABLE `run_inherited_evidence` (
	`run_id` text NOT NULL,
	`via_run_id` text NOT NULL,
	`via_workflow_id` text NOT NULL,
	`via_principal` text NOT NULL,
	`document_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`permission_id` text NOT NULL,
	`recalled` integer NOT NULL,
	PRIMARY KEY(`run_id`, `via_run_id`, `document_id`, `permission_id`)
);
