CREATE TABLE `session_journal` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` text NOT NULL,
	`session_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`version_id` text NOT NULL,
	`kind` text NOT NULL,
	`at` integer NOT NULL,
	`event` text,
	`code` text,
	`snapshot` text,
	`digest` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_journal_order` ON `session_journal` (`channel_id`,`session_id`,`seq`);