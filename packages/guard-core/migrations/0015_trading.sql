CREATE TABLE `daily_trades` (
	`agent_id` text NOT NULL,
	`chain` text NOT NULL,
	`day` text NOT NULL,
	`bought` text DEFAULT '0' NOT NULL,
	PRIMARY KEY(`agent_id`, `chain`, `day`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `positions` (
	`agent_id` text NOT NULL,
	`chain` text NOT NULL,
	`token` text NOT NULL,
	`amount` text NOT NULL,
	`cost` text NOT NULL,
	`decimals` integer NOT NULL,
	`symbol` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`agent_id`, `chain`, `token`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `intents` ADD `swap` text;--> statement-breakpoint
ALTER TABLE `policies` ADD `trading` text;