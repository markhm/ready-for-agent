ALTER TABLE `repository` ADD `fp_project_directory` text;--> statement-breakpoint
ALTER TABLE `repository` ADD `fp_in_progress_status` text;--> statement-breakpoint
ALTER TABLE `repository` ADD `fp_done_status` text;--> statement-breakpoint
CREATE UNIQUE INDEX `repository_fp_project_directory_uidx`
  ON `repository` (`fp_project_directory`)
  WHERE `fp_project_directory` IS NOT NULL AND `fp_project_directory` != '';
