CREATE TABLE `proposal_ballot_options` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`ballot_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`option` integer NOT NULL,
	FOREIGN KEY (`ballot_id`) REFERENCES `proposal_ballots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_ballot_option` ON `proposal_ballot_options` (`channel_id`,`ballot_id`,`option`);--> statement-breakpoint
CREATE TABLE `proposal_ballots` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE INDEX `proposal_ballot_channel` ON `proposal_ballots` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `proposal_contributors` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`account_id` text NOT NULL,
	`display_name` text NOT NULL,
	`event_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_contributor_identity` ON `proposal_contributors` (`channel_id`,`proposal_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `proposal_credit` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`account_id` text NOT NULL,
	`enabled` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_credit_identity` ON `proposal_credit` (`channel_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `proposal_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_grant_identity` ON `proposal_grants` (`channel_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `proposal_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`revision` integer NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `proposal_history_channel` ON `proposal_history` (`channel_id`,`proposal_id`,`id`);--> statement-breakpoint
CREATE TABLE `proposal_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`event_id` text NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text,
	`proposal_id` text,
	`result` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_receipt_identity` ON `proposal_receipts` (`channel_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `proposal_receipt_recent` ON `proposal_receipts` (`channel_id`,`kind`,`at`);--> statement-breakpoint
CREATE TABLE `proposal_selections` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`proposal_revision` integer NOT NULL,
	`brief` text NOT NULL,
	`base_version_id` text,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `proposal_selection_channel` ON `proposal_selections` (`channel_id`,`proposal_id`);--> statement-breakpoint
CREATE TABLE `proposal_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`ballot_id` text NOT NULL,
	`account_id` text NOT NULL,
	`option` integer NOT NULL,
	`event_id` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`ballot_id`) REFERENCES `proposal_ballots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_vote_identity` ON `proposal_votes` (`channel_id`,`ballot_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `proposal_votes_ballot` ON `proposal_votes` (`channel_id`,`ballot_id`,`option`);--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`text` text NOT NULL,
	`normalized_text` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_normalized` ON `proposals` (`channel_id`,`normalized_text`);--> statement-breakpoint
CREATE INDEX `proposal_channel_state` ON `proposals` (`channel_id`,`state`);