CREATE TABLE `executions` (
	`seq` integer PRIMARY KEY NOT NULL,
	`prev_hash` text NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`server` text NOT NULL,
	`tool` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_hash` text NOT NULL,
	`outcome` text NOT NULL,
	`assurance` text NOT NULL,
	`payment_receipt` text,
	`started_at` text NOT NULL,
	`ended_at` text NOT NULL,
	`issued_at` text NOT NULL,
	`hash` text NOT NULL,
	`signature` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `executions_hash_unique` ON `executions` (`hash`);--> statement-breakpoint
CREATE INDEX `executions_agent_issued` ON `executions` (`agent_id`,`issued_at`);