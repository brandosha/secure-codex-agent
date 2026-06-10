CREATE TABLE `agent_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `event_type` text NOT NULL,
  `raw_json` text NOT NULL
);
