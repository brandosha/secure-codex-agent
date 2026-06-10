import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Context } from "hono";

import { agent } from "./agent";
import { server, startServer } from "./server";

export const WORKSPACE_PATH = "/home/agent/workspace";
export { agent };

export class Tool {

}

export class EndpointTool extends Tool {
  route: string;
  handler: (c: Context) => Promise<Response>;

  constructor(route: string, handler: (c: Context) => Promise<Response>) {
    if (!route.startsWith("/")) {
      throw new Error("Route must start with '/'");
    }

    super();

    this.route = route;
    this.handler = handler;
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
    if (tool instanceof EndpointTool) {
      server.use(tool.route, tool.handler);
    }

    if (tool instanceof McpTool) {
      console.log(`Registered MCP tool: ${tool.name} at route ${tool.route}`);
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
