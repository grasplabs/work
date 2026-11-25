CREATE TABLE `connection_tools` (
	`connection_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`input_schema` text NOT NULL,
	`output_schema` text,
	`annotations` text NOT NULL,
	PRIMARY KEY(`connection_id`, `name`),
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`resource` text,
	`auth` text NOT NULL,
	`header` text,
	`issuer` text,
	`authorization_endpoint` text,
	`token_endpoint` text,
	`revocation_endpoint` text,
	`scopes` text,
	`iss_parameter` integer,
	`registration` text,
	`client_id` text,
	`client_secret` text,
	`client_authentication` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connectors_url_idx` ON `connectors` (`url`);--> statement-breakpoint
ALTER TABLE `connections` ADD `tool_list_read_at` integer;--> statement-breakpoint
ALTER TABLE `connections` ADD `tool_list_fresh_until` integer;