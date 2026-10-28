CREATE TABLE `brain_erased_documents` (
	`purge_id` text NOT NULL,
	`document_id` text NOT NULL,
	`place` text NOT NULL,
	`erased_at` integer NOT NULL,
	PRIMARY KEY(`purge_id`, `document_id`)
);
--> statement-breakpoint
CREATE INDEX `brain_erased_documents_place_idx` ON `brain_erased_documents` (`place`);