import fs from "fs/promises";
import path from "path";

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { agent } from "../../agent";
import { mcpTextResult } from "../../utils";
import { McpTool } from "../base";

const DATA_DIRECTORY = path.resolve(import.meta.dirname, "data");
const REMINDERS_FILE_PATH = path.join(DATA_DIRECTORY, "reminders.json");
const REMINDER_PROMPT_SOURCE = "reminders/idle";

const persistedReminderSchema = z.object({
  content: z.string().trim().min(1),
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
});

const createReminderSchema = z.object({
  id: z.string().trim().min(1),
  content: z.string().trim().min(1),
});

const updateReminderSchema = z.object({
  id: z.string().trim().min(1),
  content: z.string().trim().min(1),
});

type PersistedReminder = z.infer<typeof persistedReminderSchema>;
type ReminderRecord = Record<string, PersistedReminder>;

export class RemindersTool extends McpTool {
  constructor() {
    super("reminders", createRemindersMcpServer());
  }
}

function createRemindersMcpServer() {
  const reminders: ReminderRecord = {};
  const stateMutex = createMutex();
  let reminderPromptQueued = false;
  const ready = initializeReminders();

  ready.then(() => {
    agent.subscribe((event) => {
      if (event.type !== "turn.completed") {
        return;
      }

      queueIdleReminderPrompt();
    });
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
  }, async (input) => {
    await ready;

    return stateMutex.runExclusive(async () => {
      if (reminders[input.id]) {
        return mcpTextResult(`Reminder ${input.id} already exists. Use update_reminder instead.`, true);
      }

      const now = new Date().toISOString();
      const reminder: PersistedReminder = {
        content: input.content,
        createdAt: now,
        updatedAt: now,
      };

      reminders[input.id] = reminder;
      try {
        await persistReminders(reminders);
      } catch (error) {
        delete reminders[input.id];
        return mcpTextResult(`Failed to persist reminder ${input.id}: ${formatError(error)}`, true);
      }

      return mcpTextResult(`Created reminder ${input.id}: ${JSON.stringify({ id: input.id, ...reminder })}`);
    });
  });

  mcp.registerTool("update_reminder", {
    description: "Replace an existing reminder's content when the remembered follow-up changes, becomes more specific, or needs clearer wording before it is revisited after the current work finishes.",
    inputSchema: updateReminderSchema,
  }, async (input) => {
    await ready;

    return stateMutex.runExclusive(async () => {
      const current = reminders[input.id];
      if (!current) {
        return mcpTextResult(`Reminder ${input.id} does not exist.`, true);
      }

      const nextReminder: PersistedReminder = {
        ...current,
        content: input.content,
        updatedAt: new Date().toISOString(),
      };

      reminders[input.id] = nextReminder;
      try {
        await persistReminders(reminders);
      } catch (error) {
        reminders[input.id] = current;
        return mcpTextResult(`Failed to persist reminder ${input.id}: ${formatError(error)}`, true);
      }

      return mcpTextResult(`Updated reminder ${input.id}: ${JSON.stringify({ id: input.id, ...nextReminder })}`);
    });
  });

  mcp.registerTool("delete_reminder", {
    description: "Delete a reminder as soon as it has been handled, folded into the current work, or is no longer relevant. Completion is represented by deletion so reminders do not accumulate indefinitely.",
    inputSchema: z.object({
      id: z.string().trim().min(1),
    }),
  }, async ({ id }) => {
    await ready;

    return stateMutex.runExclusive(async () => {
      const existing = reminders[id];
      if (!existing) {
        return mcpTextResult(`Reminder ${id} does not exist.`, true);
      }

      delete reminders[id];
      try {
        await persistReminders(reminders);
      } catch (error) {
        reminders[id] = existing;
        return mcpTextResult(`Failed to persist reminder deletion for ${id}: ${formatError(error)}`, true);
      }

      return mcpTextResult(`Deleted reminder ${id}.`);
    });
  });

  mcp.registerTool("list_reminders", {
    description: "List all active reminders waiting to be revisited after the agent becomes idle. Use this to check pending follow-ups before deciding whether to create, update, or delete reminders.",
  }, async () => {
    await ready;

    const list = Object.entries(reminders).map(([id, reminder]) => ({
      id,
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
    }

    await persistReminders(reminders);
  }

  async function persistReminders(nextReminders: ReminderRecord) {
    const payload = `${JSON.stringify(nextReminders, null, 2)}\n`;
    await fs.mkdir(DATA_DIRECTORY, { recursive: true });
    await fs.writeFile(REMINDERS_FILE_PATH, payload, "utf-8");
  }

  function queueIdleReminderPrompt() {
    if (reminderPromptQueued) {
      return;
    }

    reminderPromptQueued = true;
    setTimeout(async () => {
      try {
        await stateMutex.runExclusive(async () => {
          const activeReminders = Object.entries(reminders);
          if (activeReminders.length === 0) {
            return;
          }

          agent.prompt(formatReminderPrompt(activeReminders), REMINDER_PROMPT_SOURCE);
        });
      } finally {
        reminderPromptQueued = false;
      }
    }, 0);
  }
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
