CREATE TABLE `landscape_app_people` (
	`connection_id` text NOT NULL,
	`app_id` text NOT NULL,
	`person_id` text NOT NULL,
	`name` text,
	`scopes` text NOT NULL,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `app_id`, `person_id`)
);
--> statement-breakpoint
CREATE INDEX `landscape_app_people_last_seen_idx` ON `landscape_app_people` (`last_seen`);--> statement-breakpoint
CREATE TABLE `landscape_apps` (
	`connection_id` text NOT NULL,
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`publisher` text,
	`unverified_publisher` text,
	`verified` integer NOT NULL,
	`admin_scopes` text,
	`admin_seen_at` integer,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `app_id`)
);
--> statement-breakpoint
CREATE INDEX `landscape_apps_last_seen_idx` ON `landscape_apps` (`last_seen`);--> statement-breakpoint
CREATE TABLE `landscape_staged_apps` (
	`connection_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`publisher` text,
	`unverified_publisher` text,
	`verified` integer NOT NULL,
	`admin_scopes` text,
	PRIMARY KEY(`connection_id`, `started_at`, `app_id`)
);
--> statement-breakpoint
CREATE TABLE `landscape_staged_people` (
	`connection_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`app_id` text NOT NULL,
	`person_id` text NOT NULL,
	`name` text,
	`scopes` text NOT NULL,
	PRIMARY KEY(`connection_id`, `started_at`, `app_id`, `person_id`)
);
--> statement-breakpoint
CREATE TABLE `landscape_syncs` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`started_at` integer NOT NULL,
	`cursor` text,
	`reads` integer NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`retry_at` integer,
	`finished_at` integer,
	`current_since` integer
);
