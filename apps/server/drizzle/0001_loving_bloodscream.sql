CREATE TABLE `activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` text NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`automation_id` text,
	`version_id` text,
	`event_id` text,
	`viewer` text,
	`code` text,
	`message` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `activity_channel_at` ON `activity` (`channel_id`,`at`);--> statement-breakpoint
CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`title` text NOT NULL,
	`active_version_id` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `automations_channel` ON `automations` (`channel_id`);--> statement-breakpoint
CREATE TABLE `channel_state` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`panic` integer DEFAULT false NOT NULL,
	`panic_at` integer,
	`overlay_key` text NOT NULL,
	`twitch_user_id` text,
	`twitch_login` text,
	`twitch_tokens` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `compile_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`automation_id` text,
	`base_version_id` text,
	`intent` text NOT NULL,
	`status` text NOT NULL,
	`transport` text NOT NULL,
	`model` text,
	`prompt_version` text NOT NULL,
	`thread_id` text,
	`attempts` text NOT NULL,
	`usage` text,
	`duration_ms` integer,
	`error` text,
	`version_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `compile_runs_channel` ON `compile_runs` (`channel_id`);--> statement-breakpoint
CREATE TABLE `versions` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`number` integer NOT NULL,
	`parent_version_id` text,
	`artifact_id` text,
	`title` text NOT NULL,
	`intent` text NOT NULL,
	`source` text NOT NULL,
	`manifest` text NOT NULL,
	`tests` text NOT NULL,
	`behavior` text NOT NULL,
	`assumptions` text NOT NULL,
	`evidence` text NOT NULL,
	`origin` text NOT NULL,
	`compile_run_id` text,
	`status` text NOT NULL,
	`incident` text,
	`approved_at` integer,
	`activated_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `versions_channel` ON `versions` (`channel_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `versions_automation_number` ON `versions` (`automation_id`,`number`);