ALTER TABLE `brain_claims` ADD `kind` text;--> statement-breakpoint
-- A standing claim noted before its kind was kept (GRA-1748) can't be
-- shown on the Brain page, which groups claims by kind. Nothing is
-- released (hard cut): it is owed its erasure, which core's clock
-- finishes, and stands again, kind and all, under a new key at its
-- team's next intake. Changes nothing run again.
UPDATE `brain_claims` SET `erase` = 1 WHERE `kind` IS NULL AND `erase` = 0;
