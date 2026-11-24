CREATE TABLE `erased_subjects` (
	`subject_hash` text PRIMARY KEY NOT NULL,
	`key_version` integer NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `person_erasures`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `person_erasure_areas` (
	`user_id` text NOT NULL,
	`area` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `area`),
	FOREIGN KEY (`user_id`) REFERENCES `person_erasures`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `person_erasures` (
	`user_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email_hash` text,
	`email_key_version` integer NOT NULL,
	`requested_by` text NOT NULL,
	`requested_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `person_erasures_email_hash_unique` ON `person_erasures` (`email_hash`);