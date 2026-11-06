-- Expand step: a nullable column for the staff window staff open on a client (GRA-1099 needs it to bring in the kickoff).
ALTER TABLE `clients` ADD `staff_window` text;