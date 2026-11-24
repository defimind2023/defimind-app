CREATE TABLE `anchors` (
	`from_seq` integer PRIMARY KEY NOT NULL,
	`to_seq` integer NOT NULL,
	`root` text NOT NULL,
	`chain` text NOT NULL,
	`tx_id` text NOT NULL,
	`anchored_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `anchors_to_seq_unique` ON `anchors` (`to_seq`);