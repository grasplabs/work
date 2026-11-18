CREATE TABLE `staff_list_places` (
	`email` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`confirmed_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `staff_list_places_team_id_idx` ON `staff_list_places` (`team_id`);