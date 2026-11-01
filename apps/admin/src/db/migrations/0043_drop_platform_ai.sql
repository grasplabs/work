-- Grasp's own AI features are fixed in core: a stored PLATFORM_AI setting would fail
-- every deploy (unknown_setting), and nothing clears it.
DROP TABLE `platform_ai`;--> statement-breakpoint
DELETE FROM `settings` WHERE `key` = 'PLATFORM_AI';
