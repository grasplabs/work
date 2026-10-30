CREATE TABLE `brain_eval_calibrations` (
	`id` text PRIMARY KEY NOT NULL,
	`suite_id` text NOT NULL,
	`version` integer NOT NULL,
	`by` text NOT NULL,
	`samples` integer NOT NULL,
	`repeats` integer NOT NULL,
	`graded` integer NOT NULL,
	`errors` integer NOT NULL,
	`agreement` real NOT NULL,
	`instability` real NOT NULL,
	`cost` real NOT NULL,
	`passed` integer NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `brain_eval_calibrations_version_idx` ON `brain_eval_calibrations` (`suite_id`,`version`);--> statement-breakpoint
CREATE TABLE `brain_eval_labels` (
	`suite_id` text NOT NULL,
	`version` integer NOT NULL,
	`case_id` text NOT NULL,
	`output_digest` text NOT NULL,
	`output` text NOT NULL,
	`verdict` text NOT NULL,
	`labeled_by` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`suite_id`, `version`, `case_id`, `output_digest`)
);
