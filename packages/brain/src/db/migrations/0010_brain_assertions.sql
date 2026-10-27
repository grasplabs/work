CREATE TABLE `brain_assertions` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`document_id` text,
	`memory_id` text,
	`version` integer NOT NULL,
	`partition` text NOT NULL,
	`subject_entity_id` text NOT NULL,
	`subject_name` text NOT NULL,
	`predicate` text NOT NULL,
	`object_entity_id` text NOT NULL,
	`object_name` text NOT NULL,
	`valid_from` text,
	`valid_to` text,
	`evidence` text NOT NULL,
	`state` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`superseded_at` integer,
	FOREIGN KEY (`source`) REFERENCES `brain_link_jobs`(`source`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subject_entity_id`) REFERENCES `brain_entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`object_entity_id`) REFERENCES `brain_entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `brain_assertions_subject_idx` ON `brain_assertions` (`subject_entity_id`,`predicate`);--> statement-breakpoint
CREATE INDEX `brain_assertions_object_idx` ON `brain_assertions` (`object_entity_id`);--> statement-breakpoint
CREATE INDEX `brain_assertions_source_idx` ON `brain_assertions` (`source`);