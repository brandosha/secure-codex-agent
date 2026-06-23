import { serve } from "@hono/node-server";
import { McpServer, ProtocolError, ProtocolErrorCode, ResourceTemplate, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import type { ThreadEvent } from "@openai/codex-sdk";
import { Hono } from "hono";
import { z } from "zod";

import { Agent, PromptOptions } from "./agent";
import {
  archiveSubagent,
  createSubagent,
  getLatestAssistantMessage,
  getLatestSubagentEvent,
  getSubagent,
  getSubagentStatus,
  insertSubagentEvent,
  listUnarchivedSubagents,
  querySubagentEvents,
  updateSubagentThreadId,
  type LifecycleStatus,
  type Subagent,
} from "./db";
import { SUBAGENT_EVENT_TYPES, SUBAGENT_ITEM_TYPES, type SubagentInputEvent } from "./db/schema";

const SUBAGENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,63}$/;
const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
const MAX_WAIT_TIMEOUT_MS = 3_600_000;

const subagentIdSchema = z.object({
  id: z.string().regex(SUBAGENT_ID_PATTERN),
});

const startInputSchema = z.object({
  id: z.string().regex(SUBAGENT_ID_PATTERN),
  name: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
});

const promptInputSchema = z.object({
  id: z.string().regex(SUBAGENT_ID_PATTERN),
  prompt: z.string().trim().min(1),
});

const queryEventsInputSchema = z.object({
  id: z.string().regex(SUBAGENT_ID_PATTERN),
  limit: z.number().gt(0).lte(50),
  offset: z.number().gte(0).optional(),
  filter: z.object({
    eventType: z.enum(SUBAGENT_EVENT_TYPES).optional(),
    itemType: z.enum(SUBAGENT_ITEM_TYPES).optional(),
    itemId: z.string().optional(),
  }).optional(),
});

const waitInputSchema = z.object({
  id: z.string().regex(SUBAGENT_ID_PATTERN),
  timeoutMs: z.number().int().positive().lte(MAX_WAIT_TIMEOUT_MS).optional(),
});

type SubagentIdInput = z.infer<typeof subagentIdSchema>;
type StartInput = z.infer<typeof startInputSchema>;
type PromptInput = z.infer<typeof promptInputSchema>;
type QueryEventsInput = z.infer<typeof queryEventsInputSchema>;
type WaitInput = z.infer<typeof waitInputSchema>;

export function buildSubagentMcpServer() {
  const mcp = new McpServer({
    name: "Subagent MCP Tool",
    description: "An MCP server for managing subagents. NOTE: Subagents run without access to external mcp servers.",
    version: "0.0.1",
  }, {
    capabilities: {
      resources: {
        subscribe: true,
      },
    },
  });

  const subagentManager = getSubagentManager(mcp);

  mcp.registerTool("start", {
    description: "Start an async Codex subagent. Returns the status resource URI for polling and notifications.",
    inputSchema: startInputSchema,
  }, async (input) => {
    try {
      return mcpJsonResult(await subagentManager.start(input));
    } catch (error) {
      return mcpTextResult(formatError(error), true);
    }
  });

  mcp.registerTool("prompt", {
    description: "Send another prompt to an existing async Codex subagent.",
    inputSchema: promptInputSchema,
  }, async (input) => {
    try {
      return mcpJsonResult(await subagentManager.prompt(input));
    } catch (error) {
      return mcpTextResult(formatError(error), true);
    }
  });

  mcp.registerTool("abort", {
    description: "Abort an active subagent turn if it is currently loaded in this server process.",
    inputSchema: subagentIdSchema,
  }, async (input) => {
    try {
      return mcpJsonResult(await subagentManager.abort(input));
    } catch (error) {
      return mcpTextResult(formatError(error), true);
    }
  });

  mcp.registerTool("query_events", {
    description: "Query events for an existing async Codex subagent.",
    inputSchema: queryEventsInputSchema,
  }, async (input) => {
    try {
      return mcpJsonResult(await subagentManager.queryEvents(input));
    } catch (error) {
      return mcpTextResult(formatError(error), true);
    }
  });

  mcp.registerTool("list", {
    description: "List existing unarchived subagents with their lifecycle status.",
  }, async () => {
    try {
      return mcpJsonResult(await subagentManager.list());
    } catch (error) {
      return mcpTextResult(formatError(error), true);
    }
  });

  mcp.registerTool("wait", {
    description: "Wait for a live subagent to finish or fail, then return its terminal lifecycle status.",
    inputSchema: waitInputSchema,
  }, async (input) => {
    try {
      return mcpJsonResult(await subagentManager.wait(input));
    } catch (error) {
      return mcpTextResult(formatError(error), true);
    }
  });

  mcp.registerTool("archive", {
    description: "Archive a subagent so its status resource no longer appears in resources/list.",
    inputSchema: subagentIdSchema,
  }, async (input) => {
    try {
      return mcpJsonResult(await subagentManager.archive(input));
    } catch (error) {
      return mcpTextResult(formatError(error), true);
    }
  });

  mcp.registerResource("subagent-status", new ResourceTemplate("subagent://status/{id}", {
    list: async () => ({
      resources: (await subagentManager.listStatusResources()).map((subagent) => ({
        uri: subagentStatusUri(subagent.id),
        name: subagent.name,
        mimeType: "text/plain",
        description: `Lifecycle status for subagent ${subagent.id}`,
      })),
    }),
  }), {
    title: "Subagent Status",
    description: "Status-only resources for unarchived subagents.",
    mimeType: "text/plain",
  }, async (uri, variables) => {
    const id = getTemplateVariable(variables, "id");
    const status = await subagentManager.readStatusResource(id);
    return {
      contents: [{
        uri: uri.toString(),
        mimeType: "text/plain",
        text: status,
      }],
    };
  });

  return mcp;
}

function mcpTextResult(text: string, isError = false) {
  return {
    isError,
    content: [{
      type: "text" as const,
      text,
    }],
  };
}

function mcpJsonResult(value: unknown, isError = false) {
  return mcpTextResult(JSON.stringify(value), isError);
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const SUBAGENT_MCP_SERVER_PORT = 8000;
const subagentMcpAuthToken = crypto.randomUUID();

export function serveSubagentMcp() {
  const mcpApp = new Hono();

  const subagentMcp = buildSubagentMcpServer();
  const subagentMcpTransport = new WebStandardStreamableHTTPServerTransport();
  const subagentMcpConnected = subagentMcp.connect(subagentMcpTransport);

  mcpApp.all("/mcp/subagents", async (c) => {
    await subagentMcpConnected;
    if (c.req.header("Authorization") !== `Bearer ${subagentMcpAuthToken}`) {
      return c.text("Unauthorized", 401);
    }

    return subagentMcpTransport.handleRequest(c.req.raw);
  });

  mcpApp.use("*", async (c) => {
    return c.text("Not found", 404);
  });

  serve({
    fetch: mcpApp.fetch,
    hostname: "127.0.0.1",
    port: SUBAGENT_MCP_SERVER_PORT,
  }, info => {
    console.log(`Subagent MCP server running on port ${info.port}`);
  });
}

export function subagentMcpServerConfig() {
  return {
    url: `http://localhost:${SUBAGENT_MCP_SERVER_PORT}/mcp/subagents`,
    http_headers: {
      Authorization: `Bearer ${subagentMcpAuthToken}`,
    },
  };
}

interface LiveSubagent {
  agent: Agent;
  eventChain: Promise<void>;
}

interface Waiter {
  resolve: (result: WaitResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface WaitResult {
  id: string;
  uri: string;
  status: LifecycleStatus;
  latestEventId?: number;
  latestAssistantMessage?: string;
}

export class SubagentManager {
  private _liveSubagents = new Map<string, LiveSubagent>();
  private _mcp?: McpServer;
  private _waiters = new Map<string, Set<Waiter>>();

  constructor(server?: McpServer) {
    this._mcp = server;
  }

  setMcpServer(server: McpServer) {
    this._mcp = server;
  }

  async start(input: StartInput) {
    const existing = await getSubagent(input.id);
    if (existing) {
      throw new Error(`Subagent '${input.id}' already exists. Use subagent_prompt to continue it.`);
    }

    await createSubagent({ id: input.id, name: input.name });
    this._mcp?.sendResourceListChanged();
    const agent = await this._getOrCreateLiveAgent(input.id);
    await this._recordInputEvent(input.id, {
      type: "input.prompt",
      prompt: input.prompt,
    });
    agent.prompt(input.prompt);

    return this._summary(input.id);
  }

  async prompt(input: PromptInput) {
    await this._requireSubagent(input.id);
    await this.promptAgent(input.id, input.prompt);
    return this._summary(input.id);
  }

  async abort(input: SubagentIdInput) {
    await this.abortAgent(input.id);
    return this._summary(input.id);
  }

  async archive(input: SubagentIdInput) {
    await this._requireSubagent(input.id);
    await archiveSubagent(input.id);
    this._mcp?.sendResourceListChanged();
    return this._summary(input.id);
  }

  async queryEvents(input: QueryEventsInput) {
    await this._requireSubagent(input.id);
    const events = await querySubagentEvents({
      subagentId: input.id,
      limit: input.limit,
      offset: input.offset ?? 0,
      filter: input.filter,
    });

    return {
      id: input.id,
      uri: subagentStatusUri(input.id),
      limit: input.limit,
      offset: input.offset ?? 0,
      events,
    };
  }

  async wait(input: WaitInput): Promise<WaitResult> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    await this._requireSubagent(input.id);
    const status = await getSubagentStatus(input.id);
    if (isTerminalStatus(status)) {
      return this._waitResult(input.id, status);
    }

    if (!this._liveSubagents.has(input.id)) {
      throw new Error(`Subagent '${input.id}' is '${status}' but is not live in this server process; it cannot be waited on after restart.`);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        const waiters = this._waiters.get(input.id);
        waiters?.delete(waiter);
        if (waiters?.size === 0) {
          this._waiters.delete(input.id);
        }

        const latestStatus = await getSubagentStatus(input.id);
        reject(new Error(`Timed out waiting for subagent '${input.id}' after ${timeoutMs}ms. Current status: ${latestStatus}. URI: ${subagentStatusUri(input.id)}`));
      }, timeoutMs);

      const waiter: Waiter = { resolve, reject, timer };
      const waiters = this._waiters.get(input.id) ?? new Set<Waiter>();
      waiters.add(waiter);
      this._waiters.set(input.id, waiters);
    });
  }

  async readStatusResource(id: string) {
    await this._requireSubagent(id);
    return getSubagentStatus(id);
  }

  async listStatusResources() {
    return listUnarchivedSubagents();
  }

  async list() {
    const subagents = await listUnarchivedSubagents();
    return {
      subagents: await Promise.all(subagents.map(async (subagent) => {
        const latestEvent = await getLatestSubagentEvent(subagent.id);
        return {
          id: subagent.id,
          name: subagent.name,
          uri: subagentStatusUri(subagent.id),
          status: await getSubagentStatus(subagent.id),
          latestEventId: latestEvent?.id,
        };
      })),
    };
  }

  async agent(id: string) {
    await this._requireActiveSubagent(id);
    return this._getOrCreateLiveAgent(id);
  }

  async promptAgent(id: string, prompt: string, options?: PromptOptions) {
    const agent = await this.agent(id);
    await this._recordInputEvent(id, {
      type: "input.prompt",
      prompt,
    });
    agent.prompt(prompt, options);
  }

  async abortAgent(id: string) {
    await this._requireActiveSubagent(id);
    const liveSubagent = this._liveSubagents.get(id);
    if (!liveSubagent) {
      throw new Error(`Subagent '${id}' is not live in this server process.`);
    }

    await this._recordInputEvent(id, { type: "input.abort" });
    liveSubagent.agent.abort();
  }

  private async _getOrCreateLiveAgent(id: string) {
    const liveSubagent = this._liveSubagents.get(id);
    if (liveSubagent) {
      return liveSubagent.agent;
    }

    const subagent = await this._requireSubagent(id);
    const agent = new Agent({
      threadId: subagent.codexThreadId ?? undefined,
    });

    const live: LiveSubagent = {
      agent,
      eventChain: Promise.resolve(),
    };

    agent.subscribe((event) => {
      live.eventChain = live.eventChain
        .then(() => this._handleEvent(id, event))
        .catch((error) => console.error(`Error handling subagent '${id}' event:`, error));
    });

    this._liveSubagents.set(id, live);
    return agent;
  }

  private async _handleEvent(id: string, event: ThreadEvent) {
    const previousStatus = await getSubagentStatus(id);

    if (event.type === "thread.started") {
      await updateSubagentThreadId(id, event.thread_id);
    }

    const [{ id: latestEventId }] = await insertSubagentEvent({
      subagentId: id,
      eventType: event.type,
      itemType: "item" in event ? event.item.type : undefined,
      itemId: "item" in event ? event.item.id : undefined,
      eventData: event,
    });

    const nextStatus = await getSubagentStatus(id);
    if (nextStatus !== previousStatus && isTerminalStatus(nextStatus)) {
      await this._notifyStatusUpdated(id);
      await this._resolveWaiters(id, nextStatus, latestEventId);
    }
  }

  private async _recordInputEvent(id: string, event: SubagentInputEvent) {
    await insertSubagentEvent({
      subagentId: id,
      eventType: event.type,
      eventData: event,
    });
  }

  private async _notifyStatusUpdated(id: string) {
    if (!this._mcp?.isConnected()) {
      return;
    }

    try {
      await this._mcp.server.sendResourceUpdated({ uri: subagentStatusUri(id) });
    } catch (error) {
      console.error(`Error sending status update notification for subagent '${id}':`, error);
    }
  }

  private async _resolveWaiters(id: string, status: LifecycleStatus, latestEventId: number) {
    const waiters = this._waiters.get(id);
    if (!waiters) {
      return;
    }

    this._waiters.delete(id);
    const latestAssistantMessage = await getLatestAssistantMessage(id);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({
        id,
        uri: subagentStatusUri(id),
        status,
        latestEventId,
        latestAssistantMessage,
      });
    }
  }

  private async _summary(id: string) {
    const subagent = await this._requireSubagent(id);
    const latestEvent = await getLatestSubagentEvent(id);
    return {
      id,
      name: subagent.name,
      uri: subagentStatusUri(id),
      status: await getSubagentStatus(id),
      archived: subagent.archived,
      latestEventId: latestEvent?.id,
    };
  }

  private async _waitResult(id: string, status: LifecycleStatus): Promise<WaitResult> {
    const latestEvent = await getLatestSubagentEvent(id);
    return {
      id,
      uri: subagentStatusUri(id),
      status,
      latestEventId: latestEvent?.id,
      latestAssistantMessage: await getLatestAssistantMessage(id),
    };
  }

  private async _requireSubagent(id: string): Promise<Subagent> {
    const subagent = await getSubagent(id);
    if (!subagent) {
      throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, `Subagent '${id}' was not found.`);
    }
    return subagent;
  }

  private async _requireActiveSubagent(id: string): Promise<Subagent> {
    const subagent = await this._requireSubagent(id);
    if (subagent.archived) {
      throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, `Subagent '${id}' is archived.`);
    }
    return subagent;
  }
}

let subagentManager: SubagentManager | undefined;

export function getSubagentManager(mcp?: McpServer) {
  if (!subagentManager) {
    subagentManager = new SubagentManager(mcp);
  } else if (mcp) {
    subagentManager.setMcpServer(mcp);
  }
  return subagentManager;
}

function getTemplateVariable(variables: Record<string, unknown>, key: string) {
  const value = variables[key];
  if (Array.isArray(value)) {
    return String(value[0] ?? "");
  }
  return String(value ?? "");
}

function subagentStatusUri(id: string) {
  return `subagent://status/${id}`;
}

function isTerminalStatus(status: LifecycleStatus) {
  return status === "completed" || status === "failed";
}
