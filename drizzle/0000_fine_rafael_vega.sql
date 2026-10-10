CREATE TABLE `rooms` (
	`code` text PRIMARY KEY NOT NULL,
	`host_token` text NOT NULL,
	`guest_token` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`host_seen` integer NOT NULL,
	`guest_seen` integer,
	`host_signal` text,
	`guest_signal` text,
	`host_data` text,
	`guest_data` text
);
--> statement-breakpoint
CREATE INDEX `rooms_expires_at_idx` ON `rooms` (`expires_at`);