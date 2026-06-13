CREATE TABLE IF NOT EXISTS `subagents` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `codex_thread_id` text,
  `archived` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `subagent_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `subagent_id` text NOT NULL,
  `event_type` text NOT NULL,
  `item_type` text,
  `item_id` text,
  `event_data` text NOT NULL,
  `created_at` integer,
  FOREIGN KEY (`subagent_id`) REFERENCES `subagents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `subagent_id_id_idx` ON `subagent_events` (`subagent_id`, `id` DESC);
