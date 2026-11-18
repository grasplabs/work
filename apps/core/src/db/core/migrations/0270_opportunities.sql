CREATE TABLE `opportunity_dismissals` (
	`routine` text NOT NULL,
	`evidence` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`routine`, `evidence`)
);
--> statement-breakpoint
CREATE TABLE `opportunity_proposals` (
	`routine` text NOT NULL,
	`evidence` text NOT NULL,
	`proposal` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`routine`, `evidence`)
);
