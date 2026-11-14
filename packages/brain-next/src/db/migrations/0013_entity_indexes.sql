CREATE INDEX `entity_names_entity_idx` ON `entity_names` (`entity`,`type`,`folded`);--> statement-breakpoint
CREATE INDEX `memories_entity_object_idx` ON `memories` (`entity`,`object`);--> statement-breakpoint
CREATE INDEX `memories_lineage_value_idx` ON `memories` (`entity`,`attribute`,`lineage`,`value_key`);