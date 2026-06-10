import { WebSocket } from "ws";
import { z } from "zod";


export class Agent {
  private _ws: WebSocket;
  private _ready: Promise<void>;

  constructor(address: string) {
    this._ws = new WebSocket(address);
    this._ready = new Promise((resolve) => {
      this._ws.on("open", resolve);
    });
  }

  private async _send(req: WebSocketRequest) {
    await this._ready;
    this._ws.send(JSON.stringify(req));
  }

  config(options: PromptOptions) {
    this._send({ type: "config", config: options });
  }

  prompt(message: string) {
    this._send({ type: "prompt", message });
  }

  abort() {
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