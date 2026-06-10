import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Context, Hono } from "hono";

import { agent, Agent } from "../agent";
import { server, startServer } from "../server";

export const WORKSPACE_PATH = "/home/agent/workspace";

export abstract class Tool {
  start: (server: Hono, agent: Agent) => void;

  constructor(start: (server: Hono, agent: Agent) => void) {
    this.start = start;
  }
}

class EndpointTool extends Tool {
  constructor(
    public route: string,
    handler: (c: Context) => Promise<Response>
  ) {
    if (!route.startsWith("/")) {
      throw new Error("Route must start with '/'");
    }

    super((server, agent) => {
      server.all(route, handler);
    });
  }
}

export class WebhookTool extends EndpointTool {
  constructor(name: string, handler: (c: Context) => Promise<Response>) {
    const route = `/webhook/${name}`;
    super(route, handler);
  }
}


const mcpAuthToken = crypto.randomUUID();

export class McpTool extends EndpointTool {
  name: string;

  constructor(name: string, mcp: McpServer) {
    const transport = new WebStandardStreamableHTTPServerTransport();
    const connected = mcp.connect(transport);

    super(`/mcp/${name}`, async (c) => {
      await connected;
      if (c.req.header("Authorization") !== `Bearer ${mcpAuthToken}`) {
        return c.text("Unauthorized", 401);
      }

      return transport.handleRequest(c.req.raw);
    });

    this.name = name;
  }
}

export function agentTools(tools: Tool[]) {
  const mcpServersConfig: Record<string, unknown> = {}

  for (const tool of tools) {
    tool.start(server, agent);

    if (tool instanceof McpTool) {
      console.log(`Registered MCP tool: ${tool.name} `);
      mcpServersConfig[tool.name] = {
        url: `http://tools${tool.route}`,
        http_headers: {
          "Authorization": `Bearer ${mcpAuthToken}`,
        },
      };
    }
  }

  agent.config({
    codex: {
      config: {
        mcp_servers: mcpServersConfig,
      },
    },
  });

  startServer();
}
