import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { McpTool } from "./base";

export class NewrelicMcpTool extends McpTool {
  constructor() {
    super("newrelic", newrelicMcpServerBuilder);
  }
}

function newrelicMcpServerBuilder() {
  const { NEWRELIC_API_KEY } = process.env;

  if (!NEWRELIC_API_KEY) {
    throw new Error("NEWRELIC_API_KEY environment variable must be set");
  }

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
        "API-Key": NEWRELIC_API_KEY,
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
        "API-Key": NEWRELIC_API_KEY,
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