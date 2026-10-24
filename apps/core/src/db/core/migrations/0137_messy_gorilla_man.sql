CREATE TABLE `shared_mailbox_pointers` (
	`mailbox` text PRIMARY KEY NOT NULL,
	`who` text NOT NULL,
	`teams` text DEFAULT '[]' NOT NULL,
	`changed_by` text NOT NULL,
	`changed_at` integer NOT NULL
);
