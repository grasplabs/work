CREATE TABLE `brain_hand_overs` (
	`producer` text NOT NULL,
	`source_id` text NOT NULL,
	`noting` text NOT NULL,
	`noted_at` integer NOT NULL,
	PRIMARY KEY(`producer`, `source_id`)
);
--> statement-breakpoint
CREATE INDEX `brain_hand_overs_noted_at_idx` ON `brain_hand_overs` (`noted_at`);