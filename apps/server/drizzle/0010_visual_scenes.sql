CREATE TABLE `scene_heads` (
	`version_id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`revision` integer NOT NULL,
	`applied_revision` integer,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scene_heads_channel` ON `scene_heads` (`channel_id`);--> statement-breakpoint
CREATE TABLE `scene_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`revision` integer NOT NULL,
	`evidence` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scene_revision_identity` ON `scene_revisions` (`channel_id`,`version_id`,`revision`);