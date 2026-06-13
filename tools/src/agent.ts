import type { ThreadEvent } from "@openai/codex-sdk";
import { desc } from "drizzle-orm";
import { WebSocket } from "ws";
import { z } from "zod";

import { db } from "./db";
import { agentEvents } from "./db/schema";
import { PubSub } from "./PubSub";

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

export class Agent extends PubSub<AgentEvent> {
  private _readyWaiters = new Set<(ws: WebSocket) => void>();
  private _reconnectTimer?: NodeJS.Timeout;
  private _ws?: WebSocket;

  constructor(address: string) {
    super();
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
        const message = JSON.parse(data.toString()) as AgentEvent;
        this.#recordAndPublish(message);
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

  private async _send(req: WebSocketRequest) {
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

  config(options: PromptOptions) {
    this._send({ type: "config", config: options });
  }

  prompt(message: string, from: string) {
    const event: AgentEvent = { type: "input.prompt", message, from };
    if (!this.#recordAndPublish(event)) {
      return;
    }
    this._send({ type: "prompt", message });
  }

  abort(from: string) {
    const event: AgentEvent = { type: "input.abort", from };
    if (!this.#recordAndPublish(event)) {
      return;
    }
    this._send({ type: "abort" });
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

  #recordAndPublish(event: AgentEvent) {
    try {
      db.insert(agentEvents).values({
        eventType: event.type,
        rawJson: JSON.stringify(event),
      }).run();
      this.publish(event);
      return true;
    } catch (err) {
      console.error("Error persisting agent event:", err, event);
      return false;
    }
  }
}

export const agent = new Agent("ws://agent");



const promptOptionsSchema = z.object({
  codex: z.record(z.string(), z.unknown()).optional(),
  thread: z.record(z.string(), z.unknown()).optional(),
});

type PromptOptions = z.infer<typeof promptOptionsSchema>;

const websocketRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("abort"),
  }),
  z.object({
    type: z.literal("prompt"),
    message: z.string(),
  }),
  z.object({
    type: z.literal("config"),
    config: promptOptionsSchema,
  })
]);

export type WebSocketRequest = z.infer<typeof websocketRequestSchema>;
