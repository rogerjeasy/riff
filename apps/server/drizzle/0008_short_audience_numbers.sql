ALTER TABLE `proposal_ballots` ADD `number` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `proposal_ballots` SET `number` = (SELECT COUNT(*) FROM `proposal_ballots` AS `earlier` WHERE `earlier`.`channel_id` = `proposal_ballots`.`channel_id` AND (`earlier`.`created_at` < `proposal_ballots`.`created_at` OR (`earlier`.`created_at` = `proposal_ballots`.`created_at` AND `earlier`.`id` <= `proposal_ballots`.`id`)));--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_ballot_number` ON `proposal_ballots` (`channel_id`,`number`);--> statement-breakpoint
ALTER TABLE `proposals` ADD `number` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `proposals` SET `number` = (SELECT COUNT(*) FROM `proposals` AS `earlier` WHERE `earlier`.`channel_id` = `proposals`.`channel_id` AND (`earlier`.`created_at` < `proposals`.`created_at` OR (`earlier`.`created_at` = `proposals`.`created_at` AND `earlier`.`id` <= `proposals`.`id`)));--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_number` ON `proposals` (`channel_id`,`number`);
