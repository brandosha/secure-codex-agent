import fs from "fs/promises";
import path from "path";

import { CronJob } from "cron";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Agent, AgentRouter } from "../../agent";
import { mcpTextResult } from "../../utils";
import { mcpTool } from "../base";

const DATA_DIRECTORY = path.resolve(import.meta.dirname, "data");
const SCHEDULE_FILE_PATH = path.join(DATA_DIRECTORY, "schedule.json");

const persistedScheduleSchema = z.object({
  agentId: z.string().trim().min(1).optional(),
  cronTime: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
});

const scheduleKeySchema = z.string()
  .trim()
  .min(1)
  .refine((key) => !key.includes("/"), "Schedule keys cannot contain '/'.");

const createScheduleSchema = z.object({
  key: scheduleKeySchema,
  cronTime: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
});

const updateScheduleSchema = z.object({
  key: scheduleKeySchema,
  cronTime: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1).optional(),
});

type PersistedSchedule = z.infer<typeof persistedScheduleSchema>;
type ScheduleRecord = Record<string, PersistedSchedule>;

export function scheduleMcpTool() {
  return mcpTool("schedule", (agentRouter) => createScheduleMcpServer(agentRouter));
}

function createScheduleMcpServer(agentRouter: AgentRouter) {
  const jobs = new Map<string, CronJob>();
  const schedules: ScheduleRecord = {};
  const stateMutex = createMutex();
  const ready = initializeSchedules();

  const mcp = new McpServer({
    name: "Schedule MCP Tool",
    version: "0.0.1",
  });

  mcp.registerTool("create_schedule", {
    description: "Create a named recurring prompt schedule for the agent.",
    inputSchema: createScheduleSchema,
  }, async (input, ctx) => {
    await ready;

    return stateMutex.runExclusive(async () => {
      const agent = agentRouter.agent(ctx);
      const key = scheduleStorageKey(agent, input.key);
      const schedule = {
        agentId: agent.id,
        cronTime: input.cronTime,
        prompt: input.prompt,
      };

      if (schedules[key]) {
        return mcpTextResult(`Schedule ${input.key} already exists. Use update_schedule instead.`, true);
      }

      let job: CronJob;
      try {
        job = createJob(key, schedule, agentRouter, false);
      } catch (error) {
        return mcpTextResult(`Invalid cron expression for ${input.key}: ${formatError(error)}`, true);
      }

      schedules[key] = schedule;
      try {
        await persistSchedules(schedules);
      } catch (error) {
        delete schedules[key];
        return mcpTextResult(`Failed to persist schedule ${input.key}: ${formatError(error)}`, true);
      }

      jobs.set(key, job);
      job.start();
      return mcpTextResult(`Created schedule ${input.key}: ${JSON.stringify({ key: input.key, ...schedule })}`);
    });
  });

  mcp.registerTool("update_schedule", {
    description: "Update an existing schedule's cron time, prompt, or both.",
    inputSchema: updateScheduleSchema,
  }, async (input, ctx) => {
    await ready;

    return stateMutex.runExclusive(async () => {
      const agent = agentRouter.agent(ctx);
      const key = scheduleStorageKey(agent, input.key);
      const current = schedules[key];
      if (!isAgentSchedule(current, agent)) {
        return mcpTextResult(`Schedule ${input.key} does not exist.`, true);
      }

      if (input.cronTime === undefined && input.prompt === undefined) {
        return mcpTextResult("update_schedule requires cronTime, prompt, or both.", true);
      }

      const nextSchedule: PersistedSchedule = {
        agentId: current.agentId,
        cronTime: input.cronTime ?? current.cronTime,
        prompt: input.prompt ?? current.prompt,
      };

      let nextJob: CronJob;
      try {
        nextJob = createJob(key, nextSchedule, agentRouter, false);
      } catch (error) {
        return mcpTextResult(`Invalid cron expression for ${input.key}: ${formatError(error)}`, true);
      }

      schedules[key] = nextSchedule;
      try {
        await persistSchedules(schedules);
      } catch (error) {
        schedules[key] = current;
        return mcpTextResult(`Failed to persist schedule ${input.key}: ${formatError(error)}`, true);
      }

      const previousJob = jobs.get(key);
      previousJob?.stop();
      jobs.set(key, nextJob);
      nextJob.start();

      return mcpTextResult(`Updated schedule ${input.key}: ${JSON.stringify({ key: input.key, ...nextSchedule })}`);
    });
  });

  mcp.registerTool("delete_schedule", {
    description: "Delete an existing named schedule.",
    inputSchema: z.object({
      key: scheduleKeySchema,
    }),
  }, async ({ key }, ctx) => {
    await ready;

    return stateMutex.runExclusive(async () => {
      const agent = agentRouter.agent(ctx);
      const storageKey = scheduleStorageKey(agent, key);
      if (!isAgentSchedule(schedules[storageKey], agent)) {
        return mcpTextResult(`Schedule ${key} does not exist.`, true);
      }

      const existing = schedules[storageKey];
      delete schedules[storageKey];

      try {
        await persistSchedules(schedules);
      } catch (error) {
        schedules[storageKey] = existing;
        return mcpTextResult(`Failed to persist schedule deletion for ${key}: ${formatError(error)}`, true);
      }

      const job = jobs.get(storageKey);
      job?.stop();
      jobs.delete(storageKey);

      return mcpTextResult(`Deleted schedule ${key}.`);
    });
  });

  mcp.registerTool("list_schedules", {
    description: "List all saved prompt schedules.",
  }, async (ctx) => {
    await ready;
    const agent = agentRouter.agent(ctx);

    const list = Object.entries(schedules)
      .filter(([, schedule]) => isAgentSchedule(schedule, agent))
      .map(([key, schedule]) => ({
        key: scheduleDisplayKey(key, agent),
        cronTime: schedule.cronTime,
        prompt: schedule.prompt,
      }));

    return mcpTextResult(JSON.stringify(list));
  });

  return mcp;
  
  async function initializeSchedules() {
    const loadedSchedules = await loadSchedulesFromDisk();

    for (const [key, schedule] of Object.entries(loadedSchedules)) {
      try {
        jobs.set(key, createJob(key, schedule, agentRouter));
        schedules[key] = schedule;
      } catch (error) {
        console.error(`Skipping invalid persisted schedule ${key}:`, error);
      }
    }

    await persistSchedules(schedules);
  }

  async function persistSchedules(nextSchedules: ScheduleRecord) {
    const payload = `${JSON.stringify(nextSchedules, null, 2)}\n`;
    await fs.mkdir(DATA_DIRECTORY, { recursive: true });
    await fs.writeFile(SCHEDULE_FILE_PATH, payload, "utf-8");
  }
}

async function loadSchedulesFromDisk(): Promise<ScheduleRecord> {
  try {
    const raw = await fs.readFile(SCHEDULE_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error("schedule.json must contain an object keyed by schedule name.");
      return {};
    }

    const schedules: ScheduleRecord = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key.trim()) {
        console.error("Skipping persisted schedule with an empty key.");
        continue;
      }

      const result = persistedScheduleSchema.safeParse(value);
      if (!result.success) {
        console.error(`Skipping invalid persisted schedule ${key}:`, result.error);
        continue;
      }

      schedules[key] = result.data;
    }

    return schedules;
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }

    console.error("Failed to load schedule.json:", error);
    return {};
  }
}

function createJob(key: string, schedule: PersistedSchedule, agentRouter: AgentRouter, start = true) {
  return CronJob.from({
    cronTime: schedule.cronTime,
    onTick() {
      const agent = agentRouter.agent(schedule.agentId);
      agent.prompt(schedule.prompt, `schedule/${scheduleDisplayKey(key, agent)}`);
    },
    start,
  });
}

function isAgentSchedule(schedule: PersistedSchedule | undefined, agent: Agent) {
  return schedule?.agentId === agent.id;
}

function scheduleStorageKey(agent: Agent, key: string) {
  return agent.id ? `${agent.id}/${key}` : key;
}

function scheduleDisplayKey(key: string, agent: Agent) {
  const prefix = agent.id ? `${agent.id}/` : "";
  return prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function createMutex() {
  let locked = false;
  const waiters: Array<() => void> = [];

  async function acquire() {
    if (!locked) {
      locked = true;
      return;
    }

    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
    locked = true;
  }

  function release() {
    const next = waiters.shift();
    if (next) {
      next();
      return;
    }

    locked = false;
  }

  return {
    async runExclusive<T>(work: () => Promise<T>) {
      await acquire();
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}
