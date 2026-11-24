CREATE TABLE `owner_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`passkey_id` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`expires_at` text NOT NULL
);
