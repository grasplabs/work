CREATE TABLE `destination_capability_evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`destination_id` text NOT NULL,
	`capability` text NOT NULL,
	`status` text NOT NULL,
	`subject_kind` text,
	`subject_id` text,
	`procedure` text,
	`observed_at` integer,
	`recorded_by` text,
	`record` text,
	`declared_by` text NOT NULL,
	`declared_at` integer NOT NULL,
	FOREIGN KEY (`destination_id`) REFERENCES `hosting_destinations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `destination_capability_evidence_idx` ON `destination_capability_evidence` (`destination_id`,`capability`,`id`);