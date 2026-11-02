CREATE TABLE `viewer_preferences` (
	`channel_id` text NOT NULL,
	`viewer_key` text NOT NULL,
	`language` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `viewer_preferences_viewer` ON `viewer_preferences` (`channel_id`,`viewer_key`);--> statement-breakpoint
CREATE INDEX `viewer_preferences_updated` ON `viewer_preferences` (`channel_id`,`updated_at`);