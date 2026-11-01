CREATE TABLE `app_visitor_grants` (
	`app_id` text NOT NULL,
	`version` integer NOT NULL,
	`function` text NOT NULL,
	`granted_by` text NOT NULL,
	`granted_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `version`, `function`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TRIGGER `app_visitor_grants_removed_app_insert` BEFORE INSERT ON `app_visitor_grants`
WHEN EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`app_id` AND `removed_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'app_visitor_grants: takes nothing new for a removed App');
END;
