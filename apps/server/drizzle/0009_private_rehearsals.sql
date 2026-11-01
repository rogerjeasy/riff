CREATE TABLE `rehearsal_regressions` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`evidence` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rehearsal_regressions_channel` ON `rehearsal_regressions` (`channel_id`,`automation_id`);--> statement-breakpoint
CREATE TABLE `rehearsal_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`evidence` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rehearsal_runs_channel` ON `rehearsal_runs` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `rehearsal_scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`name` text NOT NULL,
	`revision` integer NOT NULL,
	`scenario` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rehearsal_scenarios_channel` ON `rehearsal_scenarios` (`channel_id`);