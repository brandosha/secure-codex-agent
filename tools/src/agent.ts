import type { ServerContext } from "@modelcontextprotocol/server";
import type { ThreadEvent } from "@openai/codex-sdk";
import { desc } from "drizzle-orm";
import { WebSocket } from "ws";
import { z } from "zod";

import { db } from "./db";
import { agentEvents } from "./db/schema";
import { PubSub } from "./PubSub";
import { Tool } from "./tools";

export type AgentEvent = ThreadEvent | {
  type: "request.error";
  message: string;
  issues: any[];
} | {
  type: "input.prompt";
  from: string;
  message: string;
} | {
  type: "input.abort";
  from: string;
}

export interface PersistedAgentEvent {
  id: number;
  eventType: string;
  rawJson: AgentEvent;
}

const SUBAGENT_ID_HEADER = "X-Subagent-Id";
const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,63}$/;

type AgentId = string | undefined;

export class AgentRouter {
  private _agents = new Map<AgentId, Agent>();
  private _connection: AgentConnection;

  constructor(address: string) {
    this._connection = new AgentConnection(address, (agentId, event) => {
      this.agent(agentId).recordAndPublish(event);
    });
  }

  agent(id?: AgentId): Agent;
  agent(ctx: ServerContext): Agent;
  agent(idOrContext?: AgentId | ServerContext) {
    const id = typeof idOrContext === "string" || idOrContext === undefined
      ? idOrContext
      : agentIdFromMcpContext(idOrContext);
    let agent = this._agents.get(id);
    if (!agent) {
      agent = new Agent(id, this._connection);
      this._agents.set(id, agent);
    }
    return agent;
  }
}

export class Agent extends PubSub<AgentEvent> {
  readonly id?: string;
  private _connection: AgentConnection;

  constructor(id: string | undefined, connection: AgentConnection) {
    super();
    this.id = id;
    this._connection = connection;
  }

  config(options: PromptOptions) {
    this._connection.send({ type: "config", agentId: this.id, config: options });
  }

  prompt(message: string, from: string) {
    const event: AgentEvent = { type: "input.prompt", message, from };
    if (!this.recordAndPublish(event)) {
      return;
    }
    this._connection.send({ type: "prompt", agentId: this.id, message });
  }

  abort(from: string) {
    const event: AgentEvent = { type: "input.abort", from };
    if (!this.recordAndPublish(event)) {
      return;
    }
    this._connection.send({ type: "abort", agentId: this.id });
  }

  listEvents(limit: number, offset = 0): PersistedAgentEvent[] {
    return this._connection.listEvents(limit, offset);
  }

  recordAndPublish(event: AgentEvent) {
    return this._connection.recordAndPublish(event, this);
  }
}

class AgentConnection {
  private _readyWaiters = new Set<(ws: WebSocket) => void>();
  private _reconnectTimer?: NodeJS.Timeout;
  private _ws?: WebSocket;

  constructor(address: string, private _onEvent: (agentId: string | undefined, event: AgentEvent) => void) {
    this._connect(address);
  }

  private _connect(address: string) {
    const ws = new WebSocket(address);
    this._ws = ws;

    ws.on("open", () => {
      console.log(`Connected to agent websocket at ${address}`);
      for (const resolve of this._readyWaiters) {
        resolve(ws);
      }
      this._readyWaiters.clear();
    });

    ws.on("message", (data) => {
      try {
        const message = websocketEventSchema.parse(JSON.parse(data.toString()));
        this._onEvent(message.agentId, message.event);
      } catch (err) {
        console.error("Error parsing message:", err, data);
      }
    });

    ws.on("error", (err) => {
      console.error(`Agent websocket error: ${err.message}`);
    });

    ws.on("close", () => {
      if (this._ws === ws) {
        this._ws = undefined;
      }
      if (!this._reconnectTimer) {
        this._reconnectTimer = setTimeout(() => {
          this._reconnectTimer = undefined;
          this._connect(address);
        }, 1000);
      }
    });
  }

  async send(req: WebSocketRequest) {
    const ws = await this._waitUntilReady();
    ws.send(JSON.stringify(req));
  }

  private async _waitUntilReady(): Promise<WebSocket> {
    if (this._ws?.readyState === WebSocket.OPEN) {
      return this._ws;
    }

    return new Promise<WebSocket>((resolve) => {
      this._readyWaiters.add(resolve);
    });
  }

  listEvents(limit: number, offset = 0): PersistedAgentEvent[] {
    const safeLimit = Math.max(0, Math.floor(limit));
    const safeOffset = Math.max(0, Math.floor(offset));

    if (safeLimit === 0) {
      return [];
    }

    return db
      .select()
      .from(agentEvents)
      .orderBy(desc(agentEvents.id))
      .limit(safeLimit)
      .offset(safeOffset)
      .all()
      .map((row) => ({
        id: row.id,
        eventType: row.eventType,
        rawJson: JSON.parse(row.rawJson) as AgentEvent,
      }));
  }

  recordAndPublish(event: AgentEvent, agent: Agent) {
    try {
      db.insert(agentEvents).values({
        eventType: event.type,
        rawJson: JSON.stringify(event),
      }).run();
      agent.publish(event);
      return true;
    } catch (err) {
      console.error("Error persisting agent event:", err, event);
      return false;
    }
  }
}

function agentIdFromMcpContext(ctx: ServerContext) {
  const id = ctx.http?.req?.headers.get(SUBAGENT_ID_HEADER)?.trim();
  if (id && !AGENT_ID_PATTERN.test(id)) {
    throw new Error(`MCP request has an invalid ${SUBAGENT_ID_HEADER} header.`);
  }
  return id || undefined;
}

export function agent(tools: Tool[]) {

}

const promptOptionsSchema = z.object({
  codex: z.record(z.string(), z.unknown()).optional(),
  thread: z.record(z.string(), z.unknown()).optional(),
});

type PromptOptions = z.infer<typeof promptOptionsSchema>;

const websocketRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("abort"),
    agentId: z.string().optional(),
  }),
  z.object({
    type: z.literal("prompt"),
    agentId: z.string().optional(),
    message: z.string(),
  }),
  z.object({
    type: z.literal("config"),
    agentId: z.string().optional(),
    config: promptOptionsSchema,
  })
]);

export type WebSocketRequest = z.infer<typeof websocketRequestSchema>;

const websocketEventSchema = z.object({
  agentId: z.string().optional(),
  event: z.custom<AgentEvent>(),
});
