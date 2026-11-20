-- App visitors are gone (GRA-2235): guests, with a platform account, took
-- their place. What their tables hold (outsiders' addresses and domains,
-- code and session hashes, who listed and granted what) goes now rather
-- than being kept for ever. The tables stay for a rollback to the release
-- before, which still reads them; a later release drops them.
DELETE FROM `app_visitor_sessions`;--> statement-breakpoint
DELETE FROM `app_visitor_codes`;--> statement-breakpoint
DELETE FROM `app_visitor_grants`;--> statement-breakpoint
DELETE FROM `app_visitor_entries`;
