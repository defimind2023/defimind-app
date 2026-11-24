CREATE TABLE `chain_settings` (
	`chain` text PRIMARY KEY NOT NULL,
	`rpc_url` text,
	`vault` text,
	`updated_at` text NOT NULL
);
