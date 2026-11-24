CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`approve_before` text NOT NULL
);
