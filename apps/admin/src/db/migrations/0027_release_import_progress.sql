CREATE TABLE `release_import_progress` (
	`release_id` text PRIMARY KEY NOT NULL,
	`manifest_sha256` text NOT NULL,
	`verified_blobs` integer NOT NULL,
	`updated_at` integer NOT NULL
);
