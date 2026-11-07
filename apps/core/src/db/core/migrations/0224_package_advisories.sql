-- npm packages in far less code (GRA-1636): the App's builder approves
-- them in the chat, and the clock's rescan tells builders of advisories
-- an approval didn't know, by the IDs it keeps here. Expand only:
-- `dependency_policy`, `dependency_approvers`, `dependency_locks`,
-- `package_cleanups`, `dependency_build_leases` and
-- `dependency_admission_refusals` are no longer read or written, and
-- GRA-1547 drops them.
ALTER TABLE `dependency_requests` ADD `advisories` text;
