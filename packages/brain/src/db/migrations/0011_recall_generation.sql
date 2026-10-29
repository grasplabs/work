-- The recall generation (GRA-304; recall-cache.ts): one counter, kept in
-- `brain_sequences` by triggers in the statement of each write, that
-- changes whenever what a recall may find does: a section indexed or
-- dropped, a document written, moved or deleted, a memory record kept,
-- changed or purged, a collection changed or deleted. A cached recall
-- holds the generation it was read at in its key, so no write since is
-- ever answered from before it.
INSERT INTO `brain_sequences` (`name`, `value`) VALUES ('recall', 0)
	ON CONFLICT (`name`) DO NOTHING;
--> statement-breakpoint
CREATE TRIGGER `recall_generation_sections_insert` AFTER INSERT ON `sections` BEGIN
	UPDATE `brain_sequences` SET `value` = `value` + 1 WHERE `name` = 'recall';
END;
--> statement-breakpoint
CREATE TRIGGER `recall_generation_sections_delete` AFTER DELETE ON `sections` BEGIN
	UPDATE `brain_sequences` SET `value` = `value` + 1 WHERE `name` = 'recall';
END;
--> statement-breakpoint
CREATE TRIGGER `recall_generation_documents_insert` AFTER INSERT ON `documents` BEGIN
	UPDATE `brain_sequences` SET `value` = `value` + 1 WHERE `name` = 'recall';
END;
--> statement-breakpoint
CREATE TRIGGER `recall_generation_documents_update` AFTER UPDATE ON `documents` BEGIN
	UPDATE `brain_sequences` SET `value` = `value` + 1 WHERE `name` = 'recall';
END;
--> statement-breakpoint
CREATE TRIGGER `recall_generation_documents_delete` AFTER DELETE ON `documents` BEGIN
	UPDATE `brain_sequences` SET `value` = `value` + 1 WHERE `name` = 'recall';
END;
--> statement-breakpoint
CREATE TRIGGER `recall_generation_memories_insert` AFTER INSERT ON `brain_memories` BEGIN
	UPDATE `brain_sequences` SET `value` = `value` + 1 WHERE `name` = 'recall';
END;
--> statement-breakpoint
CREATE TRIGGER `recall_generation_memories_update` AFTER UPDATE ON `brain_memories` BEGIN
	UPDATE `brain_sequences` SET `value` = `value` + 1 WHERE `name` = 'recall';
END;
--> statement-breakpoint
CREATE TRIGGER `recall_generation_memories_delete` AFTER DELETE ON `brain_memories` BEGIN
	UPDATE `brain_sequences` SET `value` = `value` + 1 WHERE `name` = 'recall';
END;
--> statement-breakpoint
CREATE TRIGGER `recall_generation_collections_update` AFTER UPDATE ON `collections` BEGIN
	UPDATE `brain_sequences` SET `value` = `value` + 1 WHERE `name` = 'recall';
END;
--> statement-breakpoint
CREATE TRIGGER `recall_generation_collections_delete` AFTER DELETE ON `collections` BEGIN
	UPDATE `brain_sequences` SET `value` = `value` + 1 WHERE `name` = 'recall';
END;
