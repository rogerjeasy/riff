CREATE TABLE `timers` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`version_id` text NOT NULL,
	`name` text NOT NULL,
	`interval_ms` integer NOT NULL,
	`repeat` integer NOT NULL,
	`scheduled_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`fires` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `timers_automation_name` ON `timers` (`channel_id`,`automation_id`,`name`);--> statement-breakpoint
CREATE INDEX `timers_channel_due` ON `timers` (`channel_id`,`scheduled_at`);