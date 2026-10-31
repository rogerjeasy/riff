CREATE TABLE `proposal_generation_runs` (
	`selection_id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`run_id` text NOT NULL,
	FOREIGN KEY (`selection_id`) REFERENCES `proposal_selections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `compile_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_generation_run_identity` ON `proposal_generation_runs` (`channel_id`,`run_id`);