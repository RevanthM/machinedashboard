ALTER TABLE `hosts` ADD COLUMN `nickname` text;--> statement-breakpoint
CREATE TABLE `factory_chat_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint
CREATE TABLE `factory_chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text,
	`host_ids_json` text,
	`job_id` text,
	`attachments_json` text,
	`ts` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `factory_chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `factory_chat_messages_session_idx` ON `factory_chat_messages` (`session_id`,`ts`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`error` text
);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`host_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`result_text` text,
	`artifacts_json` text,
	`error` text,
	`started_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `job_runs_job_idx` ON `job_runs` (`job_id`);--> statement-breakpoint
CREATE INDEX `job_runs_host_idx` ON `job_runs` (`host_id`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`every_minutes` integer DEFAULT 60 NOT NULL,
	`job_type` text NOT NULL,
	`host_ids_json` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`last_run_at` integer,
	`next_run_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
