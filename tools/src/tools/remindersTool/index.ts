import fs from "fs/promises";
import path from "path";

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Agent, AgentRouter } from "../../agent";
import { mcpTextResult } from "../../utils";
import { mcpTool } from "../base";

const DATA_DIRECTORY = path.resolve(import.meta.dirname, "data");
const REMINDERS_FILE_PATH = path.join(DATA_DIRECTORY, "reminders.json");
const REMINDER_PROMPT_SOURCE = "reminders/idle";

const persistedReminderSchema = z.object({
  agentId: z.string().trim().min(1).optional(),
  content: z.string().trim().min(1),
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
});

const reminderIdSchema = z.string()
  .trim()
  .min(1)
  .refine((id) => !id.includes("/"), "Reminder ids cannot contain '/'.");

const createReminderSchema = z.object({
  id: reminderIdSchema,
  content: z.string().trim().min(1),
});

const updateReminderSchema = z.object({
  id: reminderIdSchema,
  content: z.string().trim().min(1),
});

type PersistedReminder = z.infer<typeof persistedReminderSchema>;
type ReminderRecord = Record<string, PersistedReminder>;

export function remindersTool() {
  return mcpTool("reminders", (agentRouter) => createRemindersMcpServer(agentRouter));
}

function createRemindersMcpServer(agentRouter: AgentRouter) {
  const reminders: ReminderRecord = {};
  const stateMutex = createMutex();
  const subscribedAgents = new Set<string | undefined>();
  const queuedReminderPrompts = new Set<string | undefined>();
  const ready = initializeReminders();

  ready.then(() => {
    ensureAgentSubscribed(agentRouter.agent());
  }).catch((error) => {
    console.error("Failed to initialize reminders:", error);
  });

  const mcp = new McpServer({
    name: "Reminders MCP Tool",
    version: "0.0.1",
  });

  mcp.registerTool("create_reminder", {
    description: "Create an active reminder for something the agent should revisit after the current work finishes. Use this when the user adds a follow-up, side task, constraint, or request while the agent is already busy and it should not interrupt the current flow. Active reminders are shown again after each completed turn until deleted.",
    inputSchema: createReminderSchema,
  }, async (input, ctx) => {
    await ready;
    const agent = agentRouter.agent(ctx);
    ensureAgentSubscribed(agent);

    return stateMutex.runExclusive(async () => {
      const id = reminderStorageKey(agent, input.id);
      if (reminders[id]) {
        return mcpTextResult(`Reminder ${input.id} already exists. Use update_reminder instead.`, true);
      }

      const now = new Date().toISOString();
      const reminder: PersistedReminder = {
        agentId: agent.id,
        content: input.content,
        createdAt: now,
        updatedAt: now,
      };

      reminders[id] = reminder;
      try {
        await persistReminders(reminders);
      } catch (error) {
        delete reminders[id];
        return mcpTextResult(`Failed to persist reminder ${input.id}: ${formatError(error)}`, true);
      }

      return mcpTextResult(`Created reminder ${input.id}: ${JSON.stringify({ id: input.id, ...reminder })}`);
    });
  });

  mcp.registerTool("update_reminder", {
    description: "Replace an existing reminder's content when the remembered follow-up changes, becomes more specific, or needs clearer wording before it is revisited after the current work finishes.",
    inputSchema: updateReminderSchema,
  }, async (input, ctx) => {
    await ready;
    const agent = agentRouter.agent(ctx);
    ensureAgentSubscribed(agent);

    return stateMutex.runExclusive(async () => {
      const id = reminderStorageKey(agent, input.id);
      const current = reminders[id];
      if (!isAgentReminder(current, agent)) {
        return mcpTextResult(`Reminder ${input.id} does not exist.`, true);
      }

      const nextReminder: PersistedReminder = {
        ...current,
        content: input.content,
        updatedAt: new Date().toISOString(),
      };

      reminders[id] = nextReminder;
      try {
        await persistReminders(reminders);
      } catch (error) {
        reminders[id] = current;
        return mcpTextResult(`Failed to persist reminder ${input.id}: ${formatError(error)}`, true);
      }

      return mcpTextResult(`Updated reminder ${input.id}: ${JSON.stringify({ id: input.id, ...nextReminder })}`);
    });
  });

  mcp.registerTool("delete_reminder", {
    description: "Delete a reminder as soon as it has been handled, folded into the current work, or is no longer relevant. Completion is represented by deletion so reminders do not accumulate indefinitely.",
    inputSchema: z.object({
      id: reminderIdSchema,
    }),
  }, async ({ id }, ctx) => {
    await ready;
    const agent = agentRouter.agent(ctx);
    ensureAgentSubscribed(agent);

    return stateMutex.runExclusive(async () => {
      const storageId = reminderStorageKey(agent, id);
      const existing = reminders[storageId];
      if (!isAgentReminder(existing, agent)) {
        return mcpTextResult(`Reminder ${id} does not exist.`, true);
      }

      delete reminders[storageId];
      try {
        await persistReminders(reminders);
      } catch (error) {
        reminders[storageId] = existing;
        return mcpTextResult(`Failed to persist reminder deletion for ${id}: ${formatError(error)}`, true);
      }

      return mcpTextResult(`Deleted reminder ${id}.`);
    });
  });

  mcp.registerTool("list_reminders", {
    description: "List all active reminders waiting to be revisited after the agent becomes idle. Use this to check pending follow-ups before deciding whether to create, update, or delete reminders.",
  }, async (ctx) => {
    await ready;
    const agent = agentRouter.agent(ctx);
    ensureAgentSubscribed(agent);

    const list = Object.entries(reminders)
      .filter(([, reminder]) => isAgentReminder(reminder, agent))
      .map(([id, reminder]) => ({
        id: reminderDisplayId(id, agent),
        content: reminder.content,
        createdAt: reminder.createdAt,
        updatedAt: reminder.updatedAt,
      }));

    return mcpTextResult(JSON.stringify(list));
  });

  return mcp;

  async function initializeReminders() {
    const loadedReminders = await loadRemindersFromDisk();

    for (const [id, reminder] of Object.entries(loadedReminders)) {
      reminders[id] = reminder;
      ensureAgentSubscribed(agentRouter.agent(reminder.agentId));
    }

    await persistReminders(reminders);
  }

  async function persistReminders(nextReminders: ReminderRecord) {
    const payload = `${JSON.stringify(nextReminders, null, 2)}\n`;
    await fs.mkdir(DATA_DIRECTORY, { recursive: true });
    await fs.writeFile(REMINDERS_FILE_PATH, payload, "utf-8");
  }

  function ensureAgentSubscribed(agent: Agent) {
    if (subscribedAgents.has(agent.id)) {
      return;
    }

    subscribedAgents.add(agent.id);
    agent.subscribe((event) => {
      if (event.type !== "turn.completed") {
        return;
      }

      queueIdleReminderPrompt(agent);
    });
  }

  function queueIdleReminderPrompt(agent: Agent) {
    if (queuedReminderPrompts.has(agent.id)) {
      return;
    }

    queuedReminderPrompts.add(agent.id);
    setTimeout(async () => {
      try {
        await stateMutex.runExclusive(async () => {
          const activeReminders = Object.entries(reminders)
            .filter(([, reminder]) => isAgentReminder(reminder, agent))
            .map(([id, reminder]) => [reminderDisplayId(id, agent), reminder] as [string, PersistedReminder]);
          if (activeReminders.length === 0) {
            return;
          }

          agent.prompt(formatReminderPrompt(activeReminders), REMINDER_PROMPT_SOURCE);
        });
      } finally {
        queuedReminderPrompts.delete(agent.id);
      }
    }, 0);
  }
}

function isAgentReminder(reminder: PersistedReminder | undefined, agent: Agent) {
  return reminder?.agentId === agent.id;
}

function reminderStorageKey(agent: Agent, id: string) {
  return agent.id ? `${agent.id}/${id}` : id;
}

function reminderDisplayId(id: string, agent: Agent) {
  const prefix = agent.id ? `${agent.id}/` : "";
  return prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

async function loadRemindersFromDisk(): Promise<ReminderRecord> {
  try {
    const raw = await fs.readFile(REMINDERS_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error("reminders.json must contain an object keyed by reminder id.");
      return {};
    }

    const reminders: ReminderRecord = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!id.trim()) {
        console.error("Skipping persisted reminder with an empty id.");
        continue;
      }

      const result = persistedReminderSchema.safeParse(value);
      if (!result.success) {
        console.error(`Skipping invalid persisted reminder ${id}:`, result.error);
        continue;
      }

      reminders[id] = result.data;
    }

    return reminders;
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }

    console.error("Failed to load reminders.json:", error);
    return {};
  }
}

function formatReminderPrompt(reminders: Array<[string, PersistedReminder]>) {
  const lines = reminders.map(([id, reminder]) => `- ${id}: ${reminder.content}`);

  return [
    "You have active reminders now that the previous turn is complete:",
    "",
    ...lines,
    "",
    "Act on any reminders that are relevant now. If a reminder is stale, update it with update_reminder. Once a reminder has been handled or is no longer needed, delete it with delete_reminder so it is not shown again.",
  ].join("\n");
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
