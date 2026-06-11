import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { McpTool } from "./base";

export class TrelloMcpTool extends McpTool {
  constructor() {
    super("trello", trelloMcpServer());
  }
}

function trelloMcpServer() {

  const { TRELLO_API_KEY, TRELLO_TOKEN } = process.env;

  if (!TRELLO_API_KEY || !TRELLO_TOKEN) {
    throw new Error("TRELLO_API_KEY and TRELLO_TOKEN environment variables must be set");
  }

  const mcp = new McpServer({
    name: "Trello MCP Tool",
    version: "0.0.1",
  });

  mcp.registerTool("trello_api", {
    description: "Tool for interacting with Trello boards, lists, and cards.",
    inputSchema: z.object({
      endpoint: z.string(),
      method: z.enum(["GET", "POST", "PUT", "DELETE"]),
      body: z.record(z.string(), z.any()).optional(),
    }),
  }, async (input, ctx) => {

    try {
      const response = await makeTrelloApiRequest({
        method: input.method,
        endpoint: input.endpoint,
        body: input.body,
        apiKey: TRELLO_API_KEY,
        token: TRELLO_TOKEN,
        clientIdentifier: `TrelloMcpTool`,
      });

      return {
        isError: false,
        content: [{
          type: "resource",
          resource: {
            uri: "trello-api-response.json",
            mimeType: "application/json",
            text: JSON.stringify(response),
          },
        }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: "Failed to make Trello API request",
        }, {
          type: "text",
          text: `Error: ${err}`,
        }],
      };
    }
  });

  return mcp;
}

export const TRELLO_CLIENT_IDENTIFIER = "TrelloAgent";
interface TrelloApiRequest {
  apiKey: string;
  token: string;
  method: string;
  endpoint: string;
  body?: any;
  clientIdentifier?: string;
}
export async function makeTrelloApiRequest(request: TrelloApiRequest) {
  const { token, apiKey } = request;
  const clientIdentifier = request.clientIdentifier ?? TRELLO_CLIENT_IDENTIFIER;

  const url = new URL(`https://api.trello.com/1/${request.endpoint}`);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("token", token);

  const options: RequestInit = {
    method: request.method,
    headers: {
      "Content-Type": "application/json",
      "X-Trello-Client-Identifier": clientIdentifier
    },
  };

  if (request.body) {
    options.body = JSON.stringify(request.body);
  }

  const response = await fetch(url.toString(), options);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Trello API request failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  return await response.json();
}