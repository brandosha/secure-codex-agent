import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Context, Hono } from "hono";

import { Agent } from "../agent";
import { startServer } from "../server";

export const WORKSPACE_PATH = "/home/agent/workspace";


export type SimpleTool = {
  type: "simple",
  mount: (agent: Agent) => void;
};
export type HttpTool = {
  type: "http",
  route: string;
  mount: (agent: Agent) => Hono;
};
export type McpTool = {
  type: "mcp",
  name: string;
  mount: (agent: Agent) => McpServer;
};

export type AnyTool = SimpleTool | HttpTool | McpTool;

export type Tool = AnyTool | AnyTool[];


export function simpleTool(
  mount: (agent: Agent) => void
): SimpleTool {
  return {
    type: "simple",
    mount
  };
}

export function httpTool(
  route: string,
  mount: (agent: Agent) => Hono
): HttpTool {
  return {
    type: "http",
    route,
    mount
  };
}

export function mcpTool(
  name: string,
  mcp: McpServer | ((agent: Agent) => McpServer)
): McpTool {
  return {
    type: "mcp",
    name,
    mount: (agent) => {
      if (typeof mcp === "function") {
        return mcp(agent);
      }
      return mcp;
    }
  };
}

export function webhookTool(
  name: string,
  handler: (c: Context, agent: Agent) => Promise<Response>
): HttpTool {
  return httpTool(`/webhook/${name}`, (agent) => {
    const app = new Hono();
    app.all(`/`, (c) => handler(c, agent));
    return app;
  });
}

export function agentTools(tools: Tool[]) {
  const agent = new Agent("ws://agent");
  const mcpServersConfig: Record<string, unknown> = {}
  const publicApp = new Hono();
  const mcpApp = new Hono();
  const mcpAuthToken = crypto.randomUUID();

  registerAgentTools(tools, {
    agent,
    mcpServersConfig,
    publicApp,
    mcpApp,
    mcpAuthToken,
  });

  agent.config({
    codex: {
      config: {
        mcp_servers: mcpServersConfig,
      },
    },
  });

  startServer(publicApp, {
    port: 80,
    enableWebsocket: true
  });
  startServer(mcpApp, {
    port: 8000,
    enableWebsocket: false
  });
}

interface RegisterAgentToolsContext {
  agent: Agent;
  mcpServersConfig: Record<string, unknown>;
  publicApp: Hono;
  mcpApp: Hono;
  mcpAuthToken: string;
}

function registerAgentTools(tools: Tool[], context: RegisterAgentToolsContext) {
  const { agent, mcpServersConfig, publicApp, mcpApp, mcpAuthToken } = context;

  for (const tool of tools) {
    if (Array.isArray(tool)) {
      registerAgentTools(tool, context);
      continue;
    }

    if (tool.type === "http") {
      const httpApp = tool.mount(agent);
      publicApp.route(tool.route, httpApp);
    } else if (tool.type === "mcp") {
      const mcp = tool.mount(agent);

      const route = `/mcp/${tool.name}`;
      const transport = new WebStandardStreamableHTTPServerTransport();
      const connected = mcp.connect(transport);

      mcpApp.all(route, async (c) => {
        if (c.req.header("Authorization") !== `Bearer ${mcpAuthToken}`) {
          return c.text("Unauthorized", 401);
        }

        await connected;
        return transport.handleRequest(c.req.raw);
      });

      mcpServersConfig[tool.name] = {
        url: `http://tools:8000${route}`,
        http_headers: {
          "Authorization": `Bearer ${mcpAuthToken}`,
        },
      };
    } else {
      tool.mount(agent);
    }
  }
}
