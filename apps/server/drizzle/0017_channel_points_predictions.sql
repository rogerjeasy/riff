CREATE TABLE `channel_point_redemptions` (
	`channel_id` text NOT NULL,
	`redemption_id` text NOT NULL,
	`reward_id` text NOT NULL,
	`automation_id` text,
	`viewer_id` text NOT NULL,
	`viewer_name` text NOT NULL,
	`input` text DEFAULT '' NOT NULL,
	`redeemed_at` text NOT NULL,
	`received_at` integer NOT NULL,
	`status` text NOT NULL,
	`code` text,
	`reason` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_point_redemption_identity` ON `channel_point_redemptions` (`channel_id`,`redemption_id`);--> statement-breakpoint
CREATE INDEX `channel_point_redemptions_recent` ON `channel_point_redemptions` (`channel_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `channel_point_rewards` (
	`channel_id` text NOT NULL,
	`reward_id` text NOT NULL,
	`broadcaster_id` text NOT NULL,
	`title` text NOT NULL,
	`cost` integer NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`input_required` integer DEFAULT false NOT NULL,
	`cooldown_seconds` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`automation_id` text,
	`policy` text DEFAULT 'auto' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_point_reward_identity` ON `channel_point_rewards` (`channel_id`,`reward_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `channel_point_reward_automation` ON `channel_point_rewards` (`channel_id`,`automation_id`);--> statement-breakpoint
CREATE TABLE `prediction_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`source` text NOT NULL,
	`automation_id` text,
	`version_id` text,
	`event_id` text,
	`title` text NOT NULL,
	`outcomes` text NOT NULL,
	`window_seconds` integer NOT NULL,
	`status` text NOT NULL,
	`prediction_id` text,
	`message` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `prediction_requests_channel` ON `prediction_requests` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `prediction_request_event` ON `prediction_requests` (`channel_id`,`automation_id`,`event_id`);