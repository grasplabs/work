CREATE TABLE `brain_own_stores` (
	`store` text PRIMARY KEY NOT NULL,
	`reported_at` integer NOT NULL,
	`waiting` integer NOT NULL,
	`oldest_waiting_at` integer,
	`parked` integer NOT NULL,
	`failing` integer NOT NULL,
	`not_rebuilt` integer NOT NULL,
	`near_limit` integer NOT NULL
);
