CREATE TABLE `agent_wallets` (
	`agent_id` text NOT NULL,
	`chain` text NOT NULL,
	`address` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`agent_id`, `chain`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
