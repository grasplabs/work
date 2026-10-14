CREATE TABLE `business_store_members` (
	`store_id` text NOT NULL,
	`member_type` text NOT NULL,
	`member_id` text NOT NULL,
	`role` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`store_id`, `member_type`, `member_id`),
	FOREIGN KEY (`store_id`) REFERENCES `business_stores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `business_store_members_member_idx` ON `business_store_members` (`member_type`,`member_id`);