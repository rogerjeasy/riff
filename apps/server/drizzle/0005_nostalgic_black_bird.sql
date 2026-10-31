CREATE TABLE `session_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`source_version_id` text NOT NULL,
	`target_version_id` text NOT NULL,
	`source_session_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`source_digest` text NOT NULL,
	`epoch` integer NOT NULL,
	`migration_source` text NOT NULL,
	`plan` text NOT NULL,
	`evidence` text NOT NULL,
	`evidence_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`approved_at` integer,
	`applied_at` integer,
	`cancelled_at` integer,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transitions_channel_automation` ON `session_transitions` (`channel_id`,`automation_id`);--> statement-breakpoint
ALTER TABLE `channel_state` ADD `transition_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_journal` ADD `definition` text;--> statement-breakpoint
ALTER TABLE `session_journal` ADD `migration` text;