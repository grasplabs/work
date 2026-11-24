-- Rooms isn't read any more (the proposal under Contract went with it), so nothing reads or writes a client's room.
ALTER TABLE `clients` DROP COLUMN `rooms_project_id`;
