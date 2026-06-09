import { readFileSync, writeFileSync } from "fs";

import { Codex, CodexOptions, Thread, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";

import { agentRequestMessageSchema, AgentRequestMessage } from "./agent";
import { PubSub } from "./PubSub";

if (!process.send) {
  console.error("This script is meant to be run as a child process.");
  process.exit(1);
}

const CODEX_THREAD_ID_PATH = "/home/agent/codex_thread_id.txt";

interface PromptOptions {
  codex?: CodexOptions;
  thread?: ThreadOptions;
}

class CodexPromptTask {
  thread: Thread;
  prompt: string;
  private _abortController: Promise<AbortController>;
  private _unlockAbortController: (controller: AbortController) => void;

  constructor(thread: Thread, prompt: string) {
    this.thread = thread;
    this.prompt = prompt;
    this._unlockAbortController = () => {}; // Placeholder until the promise is initialized

    this._abortController = new Promise((resolve) => {
      this._unlockAbortController = resolve;
    });
  }

  async *run() {
    console.log("Starting prompt task with prompt:", this.prompt);
    const abortController = new AbortController();
    const { events } = await this.thread.runStreamed(this.prompt, {
      signal: abortController.signal,
    });

    for await (const event of events) {
      // We wait until the prompt has begun processing before it can be aborted
      if (event.type.includes("item")) {
        this._unlockAbortController(abortController);
      }
      console.log(event);
      yield event;
    }

    this._unlockAbortController(abortController);
  }

  async abort() {
    const controller = await this._abortController;
    controller.abort();
  }
}

class CodexAgent extends PubSub<ThreadEvent> {
  private _promptQueue: CodexPromptTask[] = [];
  private _threadId?: string;

  constructor() {
    super();
    try {
      this._threadId = readFileSync(CODEX_THREAD_ID_PATH, "utf-8");
      console.log("Resuming thread with ID:", this._threadId);
    } catch (err) {
      console.log("No existing thread ID found, starting a new thread.");
    }
  }

  private _getThread(options?: PromptOptions): Thread {
    options = {
      codex: {
        ...options?.codex,
      },
      thread: {
        sandboxMode: 'danger-full-access',
        skipGitRepoCheck: true,
        ...options?.thread,
        workingDirectory: "/home/agent/workspace",
      },
    };
    const codex = new Codex(options.codex);

    let thread: Thread;
    if (this._threadId) {
      return codex.resumeThread(this._threadId, options.thread);
    } else {
      return codex.startThread(options.thread);
    }
  }

  async prompt(input: string, options?: PromptOptions) {
    const thread = this._getThread(options);

    this.abort();
    this._promptQueue.push(new CodexPromptTask(thread, input));
    this._processPromptQueue();
  }

  private _processingQueue = false;
  private async _processPromptQueue() {
    if (this._processingQueue) return;
    this._processingQueue = true;

    while (this._promptQueue.length > 0) {
      const task = this._promptQueue.shift()!;

      try {
        for await (const event of task.run()) {
          if (event.type === "thread.started" && !this._threadId) {
            this._threadId = event.thread_id;
            writeFileSync(CODEX_THREAD_ID_PATH, this._threadId);
          }

          this.publish(event);
        }
      } catch (err) {
        console.error("Error processing prompt task:", err);
      }
    }

    this._processingQueue = false;
  }

  abort() {
    this._promptQueue.forEach((task) => task.abort());
  }
}

const agent = new CodexAgent();
agent.subscribe((event) => {
  process.send?.(event);
});

process.on("message", async (message) => {
  const parsedMessage = agentRequestMessageSchema.safeParse(message);
  if (!parsedMessage.success) {
    console.error("Invalid agent request message:", parsedMessage.error.issues);
    return;
  }

  const data = parsedMessage.data;
  console.log("Received message:", data);
  if (data.type === "abort") {
    agent.abort();
  } else if (data.type === "prompt") {
    agent.prompt(data.message);
  }
});