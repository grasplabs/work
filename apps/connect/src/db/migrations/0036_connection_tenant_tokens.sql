CREATE TABLE `connection_tenant_tokens` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`sealed` text NOT NULL,
	`access_expires_at` integer NOT NULL,
	`generation` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connection_tokens`(`connection_id`) ON UPDATE no action ON DELETE cascade
);
