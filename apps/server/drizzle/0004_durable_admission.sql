CREATE TABLE `admission_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`event_id` text NOT NULL,
	`viewer_id` text NOT NULL,
	`at` integer NOT NULL,
	`code` text NOT NULL,
	`effects` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admission_event_identity` ON `admission_events` (`channel_id`,`automation_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `admission_recent` ON `admission_events` (`channel_id`,`at`);