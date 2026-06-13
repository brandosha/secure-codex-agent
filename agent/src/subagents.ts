import { readFileSync, mkdirSync } from "fs";
import fs from "fs/promises";
import path from "path";

import { serve } from "@hono/node-server";
import { McpServer, ResourceTemplate, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import { Hono } from "hono";
import { z } from "zod";

import { Agent, PromptOptions } from "./agent";

const SUBAGENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,63}$/;

const subagentIdSchema = z.object({
  id: z.string().regex(SUBAGENT_ID_PATTERN),
});

export function buildSubagentMcpServer() {

  const mcp = new McpServer({
    name: "Subagent MCP Tool",
    description: "An MCP server for managing subagents. NOTE: Subagents run without access to external mcp servers.",
    version: "0.0.1",
  }, {
    capabilities: {
      resources: {
        subscribe: true,
      }
    }
  });

  const subagentManager = new SubagentManager(mcp);

  mcp.registerTool("subagent_start", {
    description: "Start an async Codex subagent. Returns a compact resource URI for status and handoff report reads.",
    inputSchema: z.object({
      id: z.string().regex(SUBAGENT_ID_PATTERN),
      title: z.string().trim().min(1),
      prompt: z.string().trim().min(1),
    }),
  }, async (input) => {
    return mcpTextResult("Not implemented.", true);
  });

  mcp.registerTool("subagent_prompt", {
    description: "Send another prompt to an existing async Codex subagent.",
    inputSchema: z.object({
      id: z.string().regex(SUBAGENT_ID_PATTERN),
      prompt: z.string().trim().min(1),
    }),
  }, async (input) => {
    return mcpTextResult("Not implemented.", true);
  });

  mcp.registerTool("subagent_abort", {
    description: "Abort an active subagent turn if it is currently loaded in this server process.",
    inputSchema: subagentIdSchema,
  }, async (input) => {
    return mcpTextResult("Not implemented.", true);
  });

  mcp.registerTool("subagent_query_events", {
    description: "Query the status of an existing async Codex subagent.",
    inputSchema: z.object({
      id: z.string().regex(SUBAGENT_ID_PATTERN),
      limit: z.number().gt(0).lte(50),
      offset: z.number().gte(0).optional(),
      filter: z.object({
        eventType: z.string().optional(),
        itemType: z.string().optional(),
        itemId: z.string().optional(),
      }).optional(),
    })
  }, async (input) => {
    return mcpTextResult("Not implemented.", true);
  });

  mcp.registerResource("subagent", "subagent://{id}", {

  }, async (uri) => {
    return {
      contents: [{
        uri: uri.toString(),
        text: "Not implemented.",
      }]
    }
  })

  return mcp;
}

function mcpTextResult(text: string, isError = false) {
  return {
    isError,
    content: [{
      type: "text" as const,
      text,
    }],
  };
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const SUBAGENT_MCP_SERVER_PORT = 8000;
const subagentMcpAuthToken = crypto.randomUUID();

export function serveSubagentMcp() {
  const mcpApp = new Hono();

  const subagentMcp = buildSubagentMcpServer();
  const subagentMcpTransport = new WebStandardStreamableHTTPServerTransport();
  const subagentMcpConnected = subagentMcp.connect(subagentMcpTransport);

  mcpApp.all("/mcp/subagents", async (c) => {
    await subagentMcpConnected;
    if (c.req.header("Authorization") !== `Bearer ${subagentMcpAuthToken}`) {
      return c.text("Unauthorized", 401);
    }

    return subagentMcpTransport.handleRequest(c.req.raw);
  });

  mcpApp.use("*", async (c) => {
    return c.text("Not found", 404);
  });

  serve({
    fetch: mcpApp.fetch,
    hostname: "127.0.0.1",
    port: SUBAGENT_MCP_SERVER_PORT,
  }, info => {
    console.log(`Subagent MCP server running on port ${info.port}`);
  });
}

export function withSubagentMcpServer(options: PromptOptions): PromptOptions {
  const codex = options.codex ?? {};
  const config = codex.config ?? {};
  const mcpServers = isRecord(config.mcp_servers) ? config.mcp_servers : {};

  return {
    ...options,
    codex: {
      ...codex,
      config: {
        ...config,
        mcp_servers: {
          ...mcpServers,
          subagents: {
            url: `http://localhost:${SUBAGENT_MCP_SERVER_PORT}/mcp/subagents`,
            http_headers: {
              Authorization: `Bearer ${subagentMcpAuthToken}`,
            },
          },
        },
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class SubagentManager {
  private _mcp: McpServer;

  constructor(server: McpServer) {
    this._mcp = server;
  }
}
