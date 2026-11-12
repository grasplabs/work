CREATE TABLE `entity_joins` (
	`merged` integer NOT NULL,
	`into_entity` integer NOT NULL,
	`reader_set` integer NOT NULL,
	`only_for` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`merged`, `reader_set`)
);
--> statement-breakpoint
CREATE INDEX `entity_joins_into_idx` ON `entity_joins` (`into_entity`,`reader_set`);--> statement-breakpoint
CREATE INDEX `entity_joins_only_for_idx` ON `entity_joins` (`only_for`);--> statement-breakpoint
CREATE TABLE `entity_proposal_decisions` (
	`proposal` integer NOT NULL,
	`reader_set` integer NOT NULL,
	`only_for` text NOT NULL,
	`accepted` integer NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`proposal`, `reader_set`)
);
--> statement-breakpoint
CREATE INDEX `entity_proposal_decisions_only_for_idx` ON `entity_proposal_decisions` (`only_for`);--> statement-breakpoint
CREATE TABLE `entity_proposals` (
	`row` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`entity` integer NOT NULL,
	`candidate` integer NOT NULL,
	`memory` integer NOT NULL,
	`candidate_memory` integer NOT NULL,
	`name` text NOT NULL,
	`candidate_name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entity_proposals_id_unique` ON `entity_proposals` (`id`);--> statement-breakpoint
CREATE INDEX `entity_proposals_entity_idx` ON `entity_proposals` (`entity`);--> statement-breakpoint
CREATE INDEX `entity_proposals_candidate_idx` ON `entity_proposals` (`candidate`);--> statement-breakpoint
CREATE INDEX `entity_proposals_memory_idx` ON `entity_proposals` (`memory`);--> statement-breakpoint
CREATE INDEX `entity_proposals_candidate_memory_idx` ON `entity_proposals` (`candidate_memory`);--> statement-breakpoint
CREATE TABLE `member_entities` (
	`member` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`entity` integer NOT NULL,
	`email` text NOT NULL,
	`linked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_entities_entity_unique` ON `member_entities` (`entity`);--> statement-breakpoint
CREATE INDEX `member_entities_subject_idx` ON `member_entities` (`subject`);--> statement-breakpoint
CREATE INDEX `member_entities_email_idx` ON `member_entities` (`email`);