CREATE TABLE `app_webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`app_id` text NOT NULL,
	`event` text NOT NULL,
	`dedupe` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`version` integer,
	`submission` text,
	`operation` text,
	`values` text,
	`values_left_out` integer DEFAULT false NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`delivery_at` integer,
	`delivered_at` integer,
	`outcome` text,
	FOREIGN KEY (`webhook_id`) REFERENCES `app_webhooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_webhook_deliveries_dedupe` ON `app_webhook_deliveries` (`webhook_id`,`dedupe`);--> statement-breakpoint
CREATE INDEX `app_webhook_deliveries_due` ON `app_webhook_deliveries` (`delivery_at`) WHERE delivered_at IS NULL;--> statement-breakpoint
CREATE TABLE `app_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`url` text NOT NULL,
	`events` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `app_webhooks_app` ON `app_webhooks` (`app_id`);
--> statement-breakpoint
CREATE TRIGGER `app_webhooks_removed_app_insert` BEFORE INSERT ON `app_webhooks`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_webhooks: takes nothing new for a removed App');
END;
--> statement-breakpoint
CREATE TRIGGER `app_webhook_deliveries_removed_app_insert` BEFORE INSERT ON `app_webhook_deliveries`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_webhook_deliveries: takes nothing new for a removed App');
END;
