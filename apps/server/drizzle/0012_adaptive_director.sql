CREATE TABLE `director_state` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`batches` text DEFAULT '[]' NOT NULL
);
