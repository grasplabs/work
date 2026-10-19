CREATE TABLE `sdk_preferences` (
	`person_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	`last_key` text,
	`last_input_hash` text,
	`last_answer_json` text
);
