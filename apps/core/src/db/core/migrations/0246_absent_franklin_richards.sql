DROP INDEX `brain_hand_overs_noted_at_idx`;--> statement-breakpoint
ALTER TABLE `brain_hand_overs` ADD `relayed_at` integer;--> statement-breakpoint
CREATE INDEX `brain_hand_overs_unrelayed_idx` ON `brain_hand_overs` (`noted_at`) WHERE "brain_hand_overs"."relayed_at" IS NULL;