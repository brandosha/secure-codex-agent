import { mkdirSync } from "fs";
import path from "path";

import { eq, and, asc, desc, max, sql } from 'drizzle-orm';
import { drizzle } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { subagentEvents } from "./schema"

export const AGENT_DATA_DIRECTORY = "/home/agent/.secure-codex-agent";
export const DATABASE_PATH = path.join(AGENT_DATA_DIRECTORY, "agent-data.sqlite");

mkdirSync(AGENT_DATA_DIRECTORY, { recursive: true });

const __dirname = import.meta.dirname;
export const db = drizzle(DATABASE_PATH);
migrate(db, { migrationsFolder: path.join(__dirname, "../../drizzle") });


interface GetThreadHistoryParams {
  subagentId: string;
  limit: number;
  offset: number;
}

/**
 * Fetches a single thread's history in reverse chronological order (newest first).
 * Generates an incremental 'threadEventId' starting from #1 for the oldest message.
 */
export async function getThreadHistory({ subagentId: threadId, limit, offset }: GetThreadHistoryParams) {
  return await db
    .select({
      id: subagentEvents.id,
      threadId: subagentEvents.subagentId,
      eventData: subagentEvents.eventData,
      createdAt: subagentEvents.createdAt,
      // Calculates thread-specific sequential IDs (#1, #2, #3...) globally
      threadEventId: sql<number>`row_number() OVER (
        PARTITION BY ${subagentEvents.subagentId}
        ORDER BY ${subagentEvents.id} ASC
      )`,
      // threadEventId: rowNumber()
      //   .over({
      //     partitionBy: subagentEvents.threadId,
      //     orderBy: asc(subagentEvents.id), 
      //   })
      //   .as('thread_event_id'),
    })
    .from(subagentEvents)
    .where(eq(subagentEvents.subagentId, threadId))
    // Flips the final result page to show newest items first
    .orderBy(desc(subagentEvents.id)) 
    .limit(limit)
    .offset(offset);
}

/**
 * Efficiently finds and returns the full data of the latest event from every single thread.
 * Leverages the (threadId, id DESC) index skip-scan capability.
 */
export async function getLatestEventPerThread() {
  // 1. Subquery to grab the highest ID grouped by threadId
  const latestIdsSubquery = db
    .select({ latestId: max(subagentEvents.id).as('latest_id') })
    .from(subagentEvents)
    .groupBy(subagentEvents.subagentId)
    .as('latest_ids');

  // 2. Join back to the main table to get full row payloads
  return await db
    .select({
      id: subagentEvents.id,
      threadId: subagentEvents.subagentId,
      eventData: subagentEvents.eventData,
      createdAt: subagentEvents.createdAt,
    })
    .from(subagentEvents)
    .innerJoin(
      latestIdsSubquery, 
      eq(subagentEvents.id, latestIdsSubquery.latestId)
    );
}

interface QuerySubagentEventsParams {
  subagentId: string;
  limit: number;
  offset: number;
  filter?: {
    eventType?: string;
    itemType?: string;
    itemId?: string;
  };
}

export async function querySubagentEvents({ subagentId, limit, offset, filter }: QuerySubagentEventsParams) {
  
}
