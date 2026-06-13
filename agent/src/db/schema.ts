import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import { desc } from "drizzle-orm";
import { sqliteTable, integer, text, index } from "drizzle-orm/sqlite-core";

export const SUBAGENT_EVENT_TYPES = [
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.updated",
  "item.completed",
  "error",
  "input.prompt",
  "input.abort",
] as const satisfies readonly SubagentStoredEvent["type"][];

export const SUBAGENT_ITEM_TYPES = [
  "agent_message",
  "reasoning",
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "todo_list",
  "error",
] as const satisfies readonly ThreadItem["type"][];

export type SubagentInputEvent = {
  type: "input.prompt";
  prompt: string;
} | {
  type: "input.abort";
};

export type SubagentStoredEvent = ThreadEvent | SubagentInputEvent;
export type SubagentEventType = typeof SUBAGENT_EVENT_TYPES[number];
export type SubagentItemType = typeof SUBAGENT_ITEM_TYPES[number];

export const subagents = sqliteTable('subagents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  codexThreadId: text('codex_thread_id'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
});

export const subagentEvents = sqliteTable('subagent_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  subagentId: text('subagent_id').notNull().references(() => subagents.id),
  eventType: text('event_type', { enum: SUBAGENT_EVENT_TYPES }).notNull(),
  itemType: text('item_type', { enum: SUBAGENT_ITEM_TYPES }),
  itemId: text('item_id'),
  eventData: text('event_data', { mode: 'json' }).notNull().$type<SubagentStoredEvent>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
}, (table) => ([
  index('subagent_id_id_idx').on(
    table.subagentId,
    desc(table.id)
  ),
]));

export type SubagentEvent = typeof subagentEvents.$inferSelect;
export type NewSubagentEvent = typeof subagentEvents.$inferInsert;
