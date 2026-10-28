CREATE TABLE `brain_entity_matches` (
	`entity_a` text NOT NULL,
	`entity_b` text NOT NULL,
	`decision` text NOT NULL,
	`evidence_document_id` text,
	`evidence_version` integer,
	`decided_by` text NOT NULL,
	`decided_at` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`entity_a`, `entity_b`),
	FOREIGN KEY (`entity_a`) REFERENCES `brain_entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entity_b`) REFERENCES `brain_entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `brain_entity_matches_b_idx` ON `brain_entity_matches` (`entity_b`);--> statement-breakpoint
CREATE INDEX `brain_entity_matches_evidence_idx` ON `brain_entity_matches` (`evidence_document_id`);