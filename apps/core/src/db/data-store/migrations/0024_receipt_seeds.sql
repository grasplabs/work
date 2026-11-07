ALTER TABLE `sdk_mutation_receipts` ADD `seed` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `sdk_mutation_receipts` SET `seed` = lower(hex(randomblob(32)));
