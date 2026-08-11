CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text,
	`tool_calls_json` text,
	`attachments_json` text,
	`ts` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_messages_session_idx` ON `chat_messages` (`session_id`,`ts`);--> statement-breakpoint
CREATE TABLE `chat_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`title` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `command_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`session_id` text,
	`source` text NOT NULL,
	`command` text NOT NULL,
	`approved_by` text,
	`exit_code` integer,
	`stdout_head` text,
	`stderr_head` text,
	`ran_at` integer DEFAULT (unixepoch()) NOT NULL,
	`duration_ms` integer,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `command_audit_host_idx` ON `command_audit` (`host_id`,`ran_at`);--> statement-breakpoint
CREATE TABLE `host_metrics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`host_id` text NOT NULL,
	`ts` integer DEFAULT (unixepoch()) NOT NULL,
	`cpu_pct` real,
	`ram_pct` real,
	`disk_pct` real,
	`net_rx_bps` real,
	`net_tx_bps` real,
	`gpu_util_pct` real,
	`gpu_mem_used_mb` real,
	`gpu_temp_c` real,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `host_metrics_host_ts_idx` ON `host_metrics` (`host_id`,`ts`);--> statement-breakpoint
CREATE TABLE `host_specs` (
	`host_id` text PRIMARY KEY NOT NULL,
	`cpu_model` text,
	`cpu_cores` integer,
	`cpu_threads` integer,
	`cpu_mhz` real,
	`ram_total_gb` real,
	`ram_free_gb` real,
	`gpu_json` text,
	`storage_json` text,
	`os_kernel` text,
	`uptime_s` integer,
	`collected_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host` text,
	`hostname` text,
	`ssh_port` integer DEFAULT 22 NOT NULL,
	`os` text,
	`os_version` text,
	`os_edition` text,
	`username` text NOT NULL,
	`auth_method` text DEFAULT 'key' NOT NULL,
	`key_path` text,
	`public_key` text,
	`known_host_key` text,
	`is_self` integer DEFAULT false NOT NULL,
	`mesh_provider` text DEFAULT 'none' NOT NULL,
	`mesh_ip` text,
	`mesh_peer_id` text,
	`mesh_status` text DEFAULT 'unknown' NOT NULL,
	`mesh_last_seen_at` integer,
	`rdp_protocol` text,
	`rdp_port` integer,
	`rdp_username` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`enable_ollama` integer DEFAULT true NOT NULL,
	`notes` text,
	`status` text DEFAULT 'unknown' NOT NULL,
	`last_seen_at` integer,
	`last_error` text,
	`provision_state` text DEFAULT 'unprovisioned' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hosts_name_uniq` ON `hosts` (`name`);--> statement-breakpoint
CREATE INDEX `hosts_mesh_ip_idx` ON `hosts` (`mesh_ip`);--> statement-breakpoint
CREATE INDEX `hosts_hostname_idx` ON `hosts` (`hostname`);--> statement-breakpoint
CREATE TABLE `llm_benchmarks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`host_id` text NOT NULL,
	`ts` integer DEFAULT (unixepoch()) NOT NULL,
	`model` text NOT NULL,
	`prompt_tokens` integer,
	`eval_tokens` integer,
	`ttft_ms` real,
	`eval_tps` real,
	`prompt_tps` real,
	`total_ms` real,
	`load_ms` real,
	`num_ctx` integer,
	`quant` text,
	`backend` text,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `llm_benchmarks_host_ts_idx` ON `llm_benchmarks` (`host_id`,`ts`);--> statement-breakpoint
CREATE INDEX `llm_benchmarks_eval_tps_idx` ON `llm_benchmarks` (`eval_tps`);--> statement-breakpoint
CREATE TABLE `provision_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`step` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`stdout` text,
	`stderr` text,
	`exit_code` integer,
	`started_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `provision_runs_host_idx` ON `provision_runs` (`host_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
