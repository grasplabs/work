-- Two of Knowledge's leftovers that the release before this one neither
-- reads nor writes (GRA-1941). uploads, upload_cleanups, knowledge_signals,
-- knowledge_signal_computations and run_brain_evidence stay for a rollback
-- to it, which still uses them, and go with the next contract migration.
DROP TABLE `app_entries`;--> statement-breakpoint
DROP TABLE `knowledge_signal_dismissals`;