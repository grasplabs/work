CREATE TABLE `brain_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`uploaded_by` text NOT NULL,
	`name` text,
	`readers` text NOT NULL,
	`team_id` text,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "brain_uploads_team_named" CHECK("brain_uploads"."readers" <> 'team' OR "brain_uploads"."team_id" IS NOT NULL)
);
