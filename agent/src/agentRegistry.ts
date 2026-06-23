import type { ThreadEvent } from "@openai/codex-sdk";

import { getMainAgent, optionsWithMcpServers, type PromptOptions } from "./agent";
import { getSubagentManager, setSubagentPromptOptionsBuilder, subagentMcpServerConfig } from "./subagents";

export interface McpServerRegistryEntry {
  url: string;
  http_headers?: Record<string, string>;
}

export type McpServerRegistry = Record<string, McpServerRegistryEntry>;

export class AgentRegistry {
  private _mainAgent = getMainAgent();
  private _externalMcpRegistry: McpServerRegistry = {};

  constructor() {
    setSubagentPromptOptionsBuilder((id, options) => this.promptOptionsForAgent(id, options));
  }

  setExternalMcpRegistry(registry: McpServerRegistry) {
    this._externalMcpRegistry = registry;
  }

  async agent(id?: string) {
    if (!id) {
      return this._mainAgent;
    }

    return getSubagentManager().agent(id);
  }

  async prompt(id: string | undefined, message: string, options: PromptOptions = {}) {
    if (!id) {
      this._mainAgent.prompt(message, this.promptOptionsForAgent(undefined, options));
      return;
    }

    await getSubagentManager().promptAgent(id, message, options);
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

  promptOptionsForAgent(id: string | undefined, options: PromptOptions = {}) {
    const externalMcpServers = this._externalMcpServersForAgent(id);
    if (id) {
      return optionsWithMcpServers(options, externalMcpServers);
    }

    return optionsWithMcpServers(options, {
      ...externalMcpServers,
      subagents: subagentMcpServerConfig(),
    });
  }

  private _externalMcpServersForAgent(id?: string): McpServerRegistry {
    if (!id) {
      return this._externalMcpRegistry;
    }

    return Object.fromEntries(Object.entries(this._externalMcpRegistry).map(([name, server]) => [
      name,
      {
        ...server,
        http_headers: {
          ...server.http_headers,
          "X-Subagent-Id": id,
        },
      },
    ]));
  }
}
