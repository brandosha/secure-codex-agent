import { fork } from "child_process";
import path from "path";
import { readFileSync, writeFileSync } from "fs";

import { Codex, Thread, ThreadEvent } from "@openai/codex-sdk";
import { z } from "zod";

import { PubSub } from "./PubSub";


export const agentRequestMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("abort"),
  }),
  z.object({
    type: z.literal("prompt"),
    message: z.string(),
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

  prompt(message: string) {
    this._send({ type: "prompt", message });
  }

  abort() {
    this._send({ type: "abort" });
  }

  private _send(req: AgentRequestMessage) {
    this._agentProcess.send(req);
  }
}

/*
const CODEX_THREAD_ID_PATH = "/agent/codex_thread_id.txt";

class CodexPromptTask {
  thread: Thread;
  prompt: string;
  done: Promise<void>;
  private _resolveDone: () => void;
  private _abortController: Promise<AbortController>;
  private _unlockAbortController: (controller: AbortController) => void;

  constructor(thread: Thread, prompt: string) {
    this.thread = thread;
    this.prompt = prompt;
    this._resolveDone = () => {}; // Placeholder until the promise is initialized
    this._unlockAbortController = () => {};

    this.done = new Promise((resolve) => {
      this._resolveDone = resolve;
    });

    this._abortController = new Promise((resolve) => {
      this._unlockAbortController = resolve;
    });
  }

  async *run() {
    const abortController = new AbortController();
    const { events } = await this.thread.runStreamed(this.prompt, {
      signal: abortController.signal,
    });

    for await (const event of events) {
      // We wait until the prompt has begun processing before it can be aborted
      if (event.type.includes("item")) {
        this._unlockAbortController(abortController);
      }
      yield event;
    }

    this._unlockAbortController(abortController);
    this._resolveDone();
  }

  async abort() {
    const controller = await this._abortController;
    controller.abort();
  }
}

class CodexAgent extends PubSub<ThreadEvent> {
  private _codex: Codex;
  private _thread: Thread;
  private _promptQueue: CodexPromptTask[] = [];

  constructor() {
    super();

    this._codex = new Codex({
      config: {}
    });

    try {
      const threadId = readFileSync(CODEX_THREAD_ID_PATH, "utf-8").trim();
      this._thread = this._codex.resumeThread(threadId);
    } catch (error) {
      this._thread = this._codex.startThread();
    }
  }

  async prompt(input: string) {
    this.abort();
    this._promptQueue.push(new CodexPromptTask(this._thread, input));
    this._processPromptQueue();
  }

  private _processingQueue = false;
  private async _processPromptQueue() {
    if (this._processingQueue) return;
    this._processingQueue = true;

    while (this._promptQueue.length > 0) {
      const task = this._promptQueue.shift()!;
      for await (const event of task.run()) {
        if (event.type === "thread.started") {
          writeFileSync(CODEX_THREAD_ID_PATH, event.thread_id);
        }
        this.publish(event);
      }
    }

    this._processingQueue = false;
  }

  abort() {
    this._promptQueue.forEach((task) => task.abort());
  }
}
*/

// export const agent = new CodexAgent();