import type { ThreadEvent } from "@openai/codex-sdk";
import { desc } from "drizzle-orm";
import { sqliteTable, integer, text, index } from "drizzle-orm/sqlite-core";

export type SubagentInputEvent = {
  type: "input.prompt";
  prompt: string;
} | {
  type: "input.abort";
};

export type SubagentStoredEvent = ThreadEvent | SubagentInputEvent;

export const subagents = sqliteTable('subagents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  codexThreadId: text('codex_thread_id'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
});

export const subagentEvents = sqliteTable('subagent_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  subagentId: text('subagent_id').notNull().references(() => subagents.id),
  eventType: text('event_type').notNull(),
  itemType: text('item_type'),
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
