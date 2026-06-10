import type { ThreadEvent } from "@openai/codex-sdk";
import { WebSocket } from "ws";
import { z } from "zod";

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

export class Agent extends PubSub<AgentEvent> {
  private _ws: WebSocket;
  private _ready: Promise<void>;

  constructor(address: string) {
    super();
    this._ws = new WebSocket(address);
    this._ready = new Promise((resolve) => {
      this._ws.on("open", resolve);
    });
    this._ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        console.log("Received message:", message);
        this.publish(message);
      } catch (err) {
        console.error("Error parsing message:", err, data);
      }
    });
  }

  private async _send(req: WebSocketRequest) {
    await this._ready;
    this._ws.send(JSON.stringify(req));
  }

  config(options: PromptOptions) {
    this._send({ type: "config", config: options });
  }

  prompt(message: string, from: string) {
    this.publish({ type: "input.prompt", message, from });
    this._send({ type: "prompt", message });
  }

  abort(from: string) {
    this.publish({ type: "input.abort", from });
    this._send({ type: "abort" });
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