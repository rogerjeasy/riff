CREATE TABLE `participation_state` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `production_state` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
