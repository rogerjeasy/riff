CREATE TABLE `collaboration_connections` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`sealed` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `collaboration_receipts` (
	`channel_id` text NOT NULL,
	`session_id` text NOT NULL,
	`event_id` text NOT NULL,
	`code` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `collaboration_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_receipt_identity` ON `collaboration_receipts` (`session_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `collaboration_receipts_channel` ON `collaboration_receipts` (`channel_id`);--> statement-breakpoint
CREATE TABLE `collaboration_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`contract` text NOT NULL,
	`snapshot` text NOT NULL,
	`members` text NOT NULL,
	`contributions` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`revision` integer NOT NULL,
	`started` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `collaboration_sessions_channel` ON `collaboration_sessions` (`channel_id`);