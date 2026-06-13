import { fork } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
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

export interface AgentOptions {
  threadId?: string;
  promptOptions?: PromptOptions;
}

const __dirname = import.meta.dirname;

export class Agent extends PubSub<ThreadEvent> {
  threadId?: string;
  promptOptions: PromptOptions;
  private _agentProcess;

  constructor(options: AgentOptions = {}) {
    super();
    
    this.threadId = options.threadId;
    this.promptOptions = options.promptOptions || {};

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
      env: {
        ...process.env,
        HOME: "/home/agent",
        CODEX_THREAD_ID: this.threadId || "",
      }
    });

    this._agentProcess.on("message", (message: ThreadEvent) => {
      if (message.type === "thread.started") {
        this.threadId = message.thread_id;
      }

      this.publish(message);
    });
  }

  prompt(message: string, options?: PromptOptions) {
    this._send({ type: "prompt", message, options: options ?? this.promptOptions });
  }

  abort() {
    this._send({ type: "abort" });
  }

  private _send(req: AgentRequestMessage) {
    this._agentProcess.send(req);
  }

  kill() {
    this._agentProcess.kill();
    this._clearSubscriptions();
  }
}

let mainAgent: Agent | undefined;
export function getMainAgent() {
  if (mainAgent) {
    return mainAgent;
  }

  const CODEX_MAIN_AGENT_THREAD_ID_PATH = "/home/agent/codex_thread_id.txt";

  let agent: Agent;

  try {
    const threadId = readFileSync(CODEX_MAIN_AGENT_THREAD_ID_PATH, "utf-8").trim();
    agent = new Agent({
      threadId
    });
  } catch (error) {
    console.error("Starting new main agent thread");
    agent = new Agent();
  }

  agent.subscribe((event) => {
    if (event.type === "thread.started") {
      mkdirSync(path.dirname(CODEX_MAIN_AGENT_THREAD_ID_PATH), { recursive: true });
      writeFileSync(CODEX_MAIN_AGENT_THREAD_ID_PATH, event.thread_id, "utf-8");
    }
  });

  mainAgent = agent;
  return agent;
}
