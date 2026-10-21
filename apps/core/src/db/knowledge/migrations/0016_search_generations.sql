ALTER TABLE `documents` ADD `indexed_version` integer;--> statement-breakpoint
ALTER TABLE `documents` ADD `index_state` text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `index_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `index_failure` text;--> statement-breakpoint
-- What the save wrote in its own batch until now: the current version's
-- sections, so every document there is is indexed at it.
UPDATE `documents` SET `indexed_version` = `current_version`, `index_state` = 'indexed';--> statement-breakpoint
CREATE INDEX `documents_index_state_idx` ON `documents` (`index_state`,`updated_at`);