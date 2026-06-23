import type { ThreadEvent } from "@openai/codex-sdk";

import { getMainAgent, optionsWithMcpServers, type PromptOptions } from "./agent";
import { getSubagentManager, subagentMcpServerConfig } from "./subagents";

export class AgentRegistry {
  private _mainAgent = getMainAgent();

  async agent(id?: string) {
    if (!id) {
      return this._mainAgent;
    }

    return getSubagentManager().agent(id);
  }

  async prompt(id: string | undefined, message: string, options: PromptOptions = {}) {
    const promptOptions = this._promptOptions(id, options);

    if (!id) {
      this._mainAgent.prompt(message, promptOptions);
      return;
    }

    await getSubagentManager().promptAgent(id, message, promptOptions);
  }

  async abort(id?: string) {
    if (!id) {
      this._mainAgent.abort();
      return;
    }

    await getSubagentManager().abortAgent(id);
  }

  async subscribe(id: string | undefined, callback: (event: ThreadEvent) => void) {
    const agent = await this.agent(id);
    return agent.subscribe(callback);
  }

  private _promptOptions(id: string | undefined, options: PromptOptions) {
    if (id) {
      return options;
    }

    return optionsWithMcpServers(options, {
      subagents: subagentMcpServerConfig(),
    });
  }
}
