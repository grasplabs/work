CREATE TABLE `directory_group_members` (
	`provider` text NOT NULL,
	`tenant` text NOT NULL,
	`group_id` text NOT NULL,
	`account_id` text NOT NULL,
	PRIMARY KEY(`provider`, `group_id`, `tenant`, `account_id`),
	FOREIGN KEY (`provider`,`tenant`,`account_id`) REFERENCES `directory_people`(`provider`,`tenant`,`account_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider`,`group_id`) REFERENCES `directory_group_teams`(`provider`,`group_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `directory_group_members_person_idx` ON `directory_group_members` (`provider`,`tenant`,`account_id`);--> statement-breakpoint
ALTER TABLE `directory_group_teams` ADD `held` text;