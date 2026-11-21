-- Guest chats are gone (GRA-2234), and with them the sweep that deleted a
-- chat 30 days after its link expired. What they hold (outsiders' words,
-- who invited them, link hashes) goes now rather than being kept for ever.
-- The tables stay for a rollback to the release before, which still reads
-- them; a later release drops them (GRA-2240). Messages first: they name
-- their chat.
DELETE FROM `guest_messages`;--> statement-breakpoint
DELETE FROM `guest_chats`;
