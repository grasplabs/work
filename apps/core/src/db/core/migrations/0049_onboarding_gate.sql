CREATE TABLE `onboarding_gate` (
	`id` text PRIMARY KEY NOT NULL,
	`closed_at` integer,
	`threshold` integer NOT NULL
);
