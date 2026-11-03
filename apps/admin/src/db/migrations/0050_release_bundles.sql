-- When a release's bundle files left the releases bucket (a release never promoted past Edge, 14 days on; its record stays for good), and which blobs each published release names, so a blob another release still needs is kept.
CREATE TABLE `release_blobs` (
	`release_id` text NOT NULL,
	`blob_key` text NOT NULL,
	PRIMARY KEY(`release_id`, `blob_key`)
);
--> statement-breakpoint
CREATE INDEX `release_blobs_blob_idx` ON `release_blobs` (`blob_key`);--> statement-breakpoint
ALTER TABLE `releases` ADD `bundle_deleted_at` integer;