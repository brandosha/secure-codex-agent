import { fork } from "child_process";
import path from "path";

import { CodexOptions, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { z } from "zod";

import { PubSub } from "./PubSub";


export interface PromptOptions {
  codex?: CodexOptions;
  thread?: ThreadOptions;
}

export const promptOptionsSchema = z.object({
  codex: z.record(z.string(), z.unknown()).optional(),
  thread: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<PromptOptions>;

export const agentRequestMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("abort"),
  }),
  z.object({
    type: z.literal("prompt"),
    message: z.string(),
    options: promptOptionsSchema.optional(),
  }),
]);

export type AgentRequestMessage = z.infer<typeof agentRequestMessageSchema>;


const __dirname = import.meta.dirname;

export class Agent extends PubSub<ThreadEvent> {
  private _agentProcess;

  constructor() {
    super();

    const { HOST_UID } = process.env;
    if (!HOST_UID) {
      throw new Error("HOST_UID environment variable is not set. Please set it to the output of `id -u`.");
    }

    const tsxPath = path.resolve(__dirname, "../node_modules/.bin/tsx");
    const agentWorkerPath = path.resolve(__dirname, "agent-worker.js");
    this._agentProcess = fork(agentWorkerPath, {
      execPath: tsxPath,
      uid: parseInt(HOST_UID, 10),
      gid: parseInt(HOST_UID, 10),
    });

    this._agentProcess.on("message", (message: ThreadEvent) => {
      this.publish(message);
    });
  }

  prompt(message: string, options?: PromptOptions) {
    this._send({ type: "prompt", message, options });
  }

  abort() {
    this._send({ type: "abort" });
  }

  private _send(req: AgentRequestMessage) {
    this._agentProcess.send(req);
  }
}
