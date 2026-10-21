CREATE TABLE `client_placements` (
	`client_id` text PRIMARY KEY NOT NULL,
	`deployment_id` text NOT NULL,
	`destination_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`placed_by` text NOT NULL,
	`placed_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`destination_id`) REFERENCES `hosting_destinations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `client_placements_deployment_id_unique` ON `client_placements` (`deployment_id`);--> statement-breakpoint
CREATE TABLE `client_resources` (
	`client_id` text NOT NULL,
	`role` text NOT NULL,
	`kind` text NOT NULL,
	`destination_id` text NOT NULL,
	`physical_name` text NOT NULL,
	`provider_id` text,
	`jurisdiction` text NOT NULL,
	`owner` text NOT NULL,
	`operation_id` text NOT NULL,
	`lifecycle` text DEFAULT 'allocated' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`client_id`, `role`),
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`destination_id`) REFERENCES `hosting_destinations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `client_resources_physical_idx` ON `client_resources` (`destination_id`,`kind`,`physical_name`);--> statement-breakpoint
CREATE TABLE `hosting_destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`account_id` text,
	`namespace` text,
	`policies` text NOT NULL,
	`capabilities` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
