CREATE TABLE `experience_sessions` (
	`automation_id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`id` text NOT NULL,
	`version_id` text NOT NULL,
	`definition` text NOT NULL,
	`snapshot` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `experience_sessions_id_unique` ON `experience_sessions` (`id`);--> statement-breakpoint
CREATE INDEX `sessions_channel` ON `experience_sessions` (`channel_id`);--> statement-breakpoint
CREATE TABLE `session_events` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`session_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`version_id` text NOT NULL,
	`event_id` text NOT NULL,
	`at` integer NOT NULL,
	`event` text NOT NULL,
	`code` text NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_event_identity` ON `session_events` (`channel_id`,`session_id`,`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_automation_event_identity` ON `session_events` (`channel_id`,`automation_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `session_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`session_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`version_id` text NOT NULL,
	`decision` text NOT NULL,
	`viewer` text,
	`at` integer NOT NULL,
	`dispatched_at` integer
);
--> statement-breakpoint
CREATE INDEX `session_outbox_channel` ON `session_outbox` (`channel_id`,`automation_id`);