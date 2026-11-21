PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_directory_group_members` (
	`provider` text NOT NULL,
	`tenant` text NOT NULL,
	`group_id` text NOT NULL,
	`account_id` text NOT NULL,
	`read_at` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`provider`, `group_id`, `tenant`, `account_id`),
	FOREIGN KEY (`provider`,`tenant`,`account_id`) REFERENCES `directory_people`(`provider`,`tenant`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_directory_group_members`("provider", "tenant", "group_id", "account_id") SELECT "provider", "tenant", "group_id", "account_id" FROM `directory_group_members`;--> statement-breakpoint
DROP TABLE `directory_group_members`;--> statement-breakpoint
ALTER TABLE `__new_directory_group_members` RENAME TO `directory_group_members`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `directory_group_members_person_idx` ON `directory_group_members` (`provider`,`tenant`,`account_id`);--> statement-breakpoint
ALTER TABLE `source_reader_groups` ADD `directory_read_at` integer;--> statement-breakpoint
ALTER TABLE `source_reader_groups` ADD `directory_tried_at` integer;