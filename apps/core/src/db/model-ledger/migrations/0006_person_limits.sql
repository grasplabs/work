CREATE TABLE `person_limits` (
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`monthly_micros` integer,
	`messages_an_hour` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`subject_type`, `subject_id`),
	CONSTRAINT "person_limits_monthly" CHECK("person_limits"."monthly_micros" IS NULL OR "person_limits"."monthly_micros" >= 0),
	CONSTRAINT "person_limits_messages" CHECK("person_limits"."messages_an_hour" IS NULL OR "person_limits"."messages_an_hour" > 0)
);
