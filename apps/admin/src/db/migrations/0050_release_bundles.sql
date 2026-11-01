-- When a release's bundle files left the releases bucket: a release never promoted past Edge, 14 days on. Its record stays for good.
ALTER TABLE `releases` ADD `bundle_deleted_at` integer;