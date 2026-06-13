import { mkdirSync } from "fs";
import path from "path";

import { and, desc, eq, max, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { subagentEvents, subagents, type NewSubagentEvent, type SubagentEventType, type SubagentItemType } from "./schema";

export const AGENT_DATA_DIRECTORY = "/home/agent/.secure-codex-agent";
export const DATABASE_PATH = path.join(AGENT_DATA_DIRECTORY, "agent-data.sqlite");

mkdirSync(AGENT_DATA_DIRECTORY, { recursive: true });

const __dirname = import.meta.dirname;
export const db = drizzle(DATABASE_PATH);
migrate(db, { migrationsFolder: path.join(__dirname, "../../drizzle") });

export type Subagent = typeof subagents.$inferSelect;
export type LifecycleStatus = "started" | "running" | "completed" | "failed";

export async function createSubagent(input: { id: string; name: string }) {
  return db.insert(subagents).values({
    id: input.id,
    name: input.name,
    archived: false,
  });
}

export async function getSubagent(id: string) {
  const [subagent] = await db.select().from(subagents).where(eq(subagents.id, id)).limit(1);
  return subagent;
}

export async function listUnarchivedSubagents() {
  return db.select().from(subagents).where(eq(subagents.archived, false));
}

export async function archiveSubagent(id: string) {
  return db.update(subagents).set({ archived: true }).where(eq(subagents.id, id));
}

export async function updateSubagentThreadId(id: string, codexThreadId: string) {
  return db.update(subagents).set({ codexThreadId }).where(eq(subagents.id, id));
}

export async function insertSubagentEvent(event: NewSubagentEvent) {
  return db.insert(subagentEvents).values(event).returning({ id: subagentEvents.id });
}

export async function getLatestSubagentEvent(subagentId: string) {
  const [event] = await db
    .select()
    .from(subagentEvents)
    .where(eq(subagentEvents.subagentId, subagentId))
    .orderBy(desc(subagentEvents.id))
    .limit(1);
  return event;
}

export async function getLatestAssistantMessage(subagentId: string) {
  const [event] = await db
    .select()
    .from(subagentEvents)
    .where(
      and(
        eq(subagentEvents.subagentId, subagentId),
        eq(subagentEvents.eventType, "item.completed"),
        eq(subagentEvents.itemType, "agent_message"),
      ),
    )
    .orderBy(desc(subagentEvents.id))
    .limit(1);

  if (event?.eventData.type === "item.completed" && event.eventData.item.type === "agent_message") {
    return event.eventData.item.text;
  }

  return undefined;
}

export async function getSubagentStatus(subagentId: string): Promise<LifecycleStatus> {
  const event = await getLatestSubagentEvent(subagentId);
  return getStatusFromEvent(event?.eventType);
}

function getStatusFromEvent(eventType?: SubagentEventType): LifecycleStatus {
  if (!eventType) {
    return "started";
  }

  if (eventType === "turn.completed") {
    return "completed";
  }

  if (eventType === "turn.failed" || eventType === "error") {
    return "failed";
  }

  return "running";
}

export async function getLatestEventPerThread() {
  const latestIdsSubquery = db
    .select({ latestId: max(subagentEvents.id).as("latest_id") })
    .from(subagentEvents)
    .groupBy(subagentEvents.subagentId)
    .as("latest_ids");

  return db
    .select({
      id: subagentEvents.id,
      threadId: subagentEvents.subagentId,
      eventData: subagentEvents.eventData,
      createdAt: subagentEvents.createdAt,
    })
    .from(subagentEvents)
    .innerJoin(latestIdsSubquery, eq(subagentEvents.id, latestIdsSubquery.latestId));
}

interface QuerySubagentEventsParams {
  subagentId: string;
  limit: number;
  offset: number;
  filter?: {
    eventType?: SubagentEventType;
    itemType?: SubagentItemType;
    itemId?: string;
  };
}

export async function querySubagentEvents({ subagentId, limit, offset, filter }: QuerySubagentEventsParams) {
  const filters = [eq(subagentEvents.subagentId, subagentId)];

  if (filter?.eventType) {
    filters.push(eq(subagentEvents.eventType, filter.eventType));
  }
  if (filter?.itemType) {
    filters.push(eq(subagentEvents.itemType, filter.itemType));
  }
  if (filter?.itemId) {
    filters.push(eq(subagentEvents.itemId, filter.itemId));
  }

  return db
    .select()
    .from(subagentEvents)
    .where(and(...filters))
    .orderBy(desc(subagentEvents.id))
    .limit(limit)
    .offset(offset);
}
