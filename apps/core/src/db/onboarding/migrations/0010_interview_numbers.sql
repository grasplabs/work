CREATE TABLE `answer_waits` (
	`day` text NOT NULL,
	`up_to` integer NOT NULL,
	`answers` integer NOT NULL,
	PRIMARY KEY(`day`, `up_to`)
);
--> statement-breakpoint
CREATE TABLE `interview_texts` (
	`person` text PRIMARY KEY NOT NULL,
	`mark` text NOT NULL,
	`interviewer` text NOT NULL,
	`locale` text NOT NULL
);
