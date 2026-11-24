DROP TABLE `destination_capability_evidence`;--> statement-breakpoint
ALTER TABLE `clients` ADD `hosting` text DEFAULT 'grasp_cloud' NOT NULL;--> statement-breakpoint
ALTER TABLE `clients` ADD `jurisdiction` text DEFAULT 'eu' NOT NULL;--> statement-breakpoint
ALTER TABLE `client_placements` DROP COLUMN `policy_id`;--> statement-breakpoint
ALTER TABLE `hosting_destinations` DROP COLUMN `policies`;--> statement-breakpoint
ALTER TABLE `hosting_destinations` DROP COLUMN `capabilities`;