CREATE TABLE `ai_provider_keys` (
	`provider` text PRIMARY KEY NOT NULL,
	`sealed` text NOT NULL,
	`mask` text NOT NULL,
	`base_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
