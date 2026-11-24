CREATE TABLE `given_up_revocations` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`owed_for` text NOT NULL,
	`reason` text NOT NULL,
	`attempts` integer NOT NULL,
	`owed_at` integer NOT NULL,
	`given_up_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `given_up_revocations_at_idx` ON `given_up_revocations` (`given_up_at`);