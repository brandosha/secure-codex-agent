import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Context, Hono } from "hono";

import { Agent, AgentRouter, type McpServerRegistry } from "../agent";
import { startServer } from "../server";

export const WORKSPACE_PATH = "/home/agent/workspace";


export type SimpleTool = {
  type: "simple",
  mount: (agentRouter: AgentRouter) => void;
};
export type HttpTool = {
  type: "http",
  route: string;
  mount: (agentRouter: AgentRouter) => Hono;
};
export type McpTool = {
  type: "mcp",
  name: string;
  mount: (agentRouter: AgentRouter) => McpServer;
};

export type AnyTool = SimpleTool | HttpTool | McpTool;

export type Tool = AnyTool | AnyTool[];


export function simpleTool(
  mount: (agentRouter: AgentRouter) => void
): SimpleTool {
  return {
    type: "simple",
    mount
  };
}

export function httpTool(
  route: string,
  mount: (agentRouter: AgentRouter) => Hono
): HttpTool {
  return {
    type: "http",
    route,
    mount
  };
}

export function mcpTool(
  name: string,
  mcp: McpServer | ((agentRouter: AgentRouter) => McpServer)
): McpTool {
  return {
    type: "mcp",
    name,
    mount: (agentRouter) => {
      if (typeof mcp === "function") {
        return mcp(agentRouter);
      }
      return mcp;
    }
  };
}

export function webhookTool(
  name: string,
  handler: (c: Context, agentRouter: AgentRouter) => Promise<Response>
): HttpTool {
  return httpTool(`/webhook/${name}`, (agentRouter) => {
    const app = new Hono();
    app.all(`/`, (c) => handler(c, agentRouter));
    return app;
  });
}

export function agentTools(tools: Tool[]) {
  const agentRouter = new AgentRouter("ws://agent");
  const mcpServersConfig: McpServerRegistry = {}
  const publicApp = new Hono();
  const mcpApp = new Hono();
  const mcpAuthToken = crypto.randomUUID();

  registerAgentTools(tools, {
    agentRouter,
    mcpServersConfig,
    publicApp,
    mcpApp,
    mcpAuthToken,
  });

  agentRouter.configureMcpRegistry(mcpServersConfig);

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
  agentRouter: AgentRouter;
  mcpServersConfig: McpServerRegistry;
  publicApp: Hono;
  mcpApp: Hono;
  mcpAuthToken: string;
}

function registerAgentTools(tools: Tool[], context: RegisterAgentToolsContext) {
  const { agentRouter, mcpServersConfig, publicApp, mcpApp, mcpAuthToken } = context;

  for (const tool of tools) {
    if (Array.isArray(tool)) {
      registerAgentTools(tool, context);
      continue;
    }

    if (tool.type === "http") {
      const httpApp = tool.mount(agentRouter);
      publicApp.route(tool.route, httpApp);
    } else if (tool.type === "mcp") {
      const mcp = tool.mount(agentRouter);

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
      tool.mount(agentRouter);
    }
  }
}
