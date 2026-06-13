import { ThreadEvent } from "@openai/codex-sdk"
import { desc } from 'drizzle-orm';
import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';

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
  eventData: text('event_data', { mode: 'json' }).notNull().$type<ThreadEvent>(),
  // Add a timestamp column if needed, but we use 'id' as our chronological anchor
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
}, (table) => ([
  // This composite index handles both reverse pagination and the "latest event" query flawlessly
  index('subagent_id_id_idx').on(
    table.subagentId,
    desc(table.id) // Newest first
  ),
]));

export type SubagentEvent = typeof subagentEvents.$inferSelect;
export type NewSubagentEvent = typeof subagentEvents.$inferInsert;


function test(e: ThreadEvent) {
  if (e.type === "item.completed") {
    if (e.item.type === "agent_message") {
      
    }
  }
}