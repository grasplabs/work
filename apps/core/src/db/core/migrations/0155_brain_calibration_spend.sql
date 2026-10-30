CREATE TABLE `brain_calibration_spend` (
	`period` text PRIMARY KEY NOT NULL,
	`reserved_micros` integer DEFAULT 0 NOT NULL,
	`spent_micros` integer DEFAULT 0 NOT NULL
);
