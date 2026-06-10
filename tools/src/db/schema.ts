import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agentEvents = sqliteTable("agent_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventType: text("event_type").notNull(),
  rawJson: text("raw_json").notNull(),
});

export type AgentEventRow = typeof agentEvents.$inferSelect;
export type NewAgentEventRow = typeof agentEvents.$inferInsert;
