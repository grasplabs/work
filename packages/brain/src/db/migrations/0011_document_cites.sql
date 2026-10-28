CREATE TABLE `brain_document_cites` (
	`document_id` text NOT NULL,
	`version` integer NOT NULL,
	`collection_id` text NOT NULL,
	`cited_document_id` text DEFAULT '' NOT NULL,
	`cited_version` integer DEFAULT 0 NOT NULL,
	`cited_payload_key` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`document_id`, `version`, `collection_id`, `cited_document_id`, `cited_version`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
