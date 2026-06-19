import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { mcpTool } from "./base";

interface NewRelicMcpToolOptions {
  apiKey: string;
}

export function newRelicMcpTool(options: NewRelicMcpToolOptions) {
  return mcpTool("newrelic", createNewRelicMcpServer(options));
}

function createNewRelicMcpServer(options: NewRelicMcpToolOptions) {
  const mcp = new McpServer({
    name: "New Relic MCP Tool",
    version: "0.0.1",
  });

  mcp.registerTool("get_accounts", {
    description: "Get a list of New Relic accounts accessible with the provided API key",
  }, async () => {
    const response = await fetch("https://api.newrelic.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "API-Key": options.apiKey,
      },
      body: JSON.stringify({
        query: `
          {
            actor {
              accounts {
                id
                name
              }
            }
          }
        `,
      }),
    });

    const data = await response.json();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data.data.actor.accounts),
        }
      ]
    }
  });

  mcp.registerTool("nrql_query", {
    description: "Execute a NRQL query against New Relic's API",
    inputSchema: z.object({
      accounts: z.array(z.number()).describe("The New Relic account IDs to query"),
      query: z.string().describe("The NRQL query to execute"),
    }),
  }, async ({ accounts, query }) => {
    const response = await fetch("https://api.newrelic.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "API-Key": options.apiKey,
      },
      body: JSON.stringify({
        query: `
          {
            actor {
              nrql(
                accounts: ${JSON.stringify(accounts)},
                query: ${JSON.stringify(query)}
              ) {
                results
              }
            }
          }
        `,
      }),
    });

    const data = await response.json();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data.data.actor.nrql.results)
        }
      ]
    };
  });

  return mcp;
}
