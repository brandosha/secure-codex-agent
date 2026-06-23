import { serve, upgradeWebSocket } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { ThreadEvent } from "@openai/codex-sdk";
import { Hono } from "hono";
import { WSContext } from "hono/ws";
import { WebSocketServer } from "ws";
import { z } from "zod";

import { AgentRegistry, type McpServerRegistryEntry } from "./agentRegistry";
import { serveSubagentMcp } from "./subagents";

serveSubagentMcp();

const agentRegistry = new AgentRegistry();
const app = new Hono();

const mcpServerRegistryEntrySchema = z.object({
  url: z.string(),
  http_headers: z.record(z.string(), z.string()).optional(),
}) satisfies z.ZodType<McpServerRegistryEntry>;

const websocketRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("abort"),
    agentId: z.string().optional(),
  }),
  z.object({
    type: z.literal("prompt"),
    agentId: z.string().optional(),
    message: z.string(),
  }),
  z.object({
    type: z.literal("mcp_registry"),
    mcpServers: z.record(z.string(), mcpServerRegistryEntrySchema),
  })
]);

type WebsocketEvent = ThreadEvent | {
  type: "request.error";
  message: string;
  issues: any[];
}

function sendEvent(ws: WSContext, event: WebsocketEvent, agentId?: string) {
  ws.send(JSON.stringify({ agentId, event }));
}

// Block any local server access
app.use("*", async (c, next) => {
  const connInfo = getConnInfo(c);
  const remoteAddr = connInfo.remote.address;

  if (["localhost", "127.0.0.1", "::1", undefined].includes(remoteAddr)) {
    return c.text("Forbidden", 403);
  }
  return next();
});

app.get("/", upgradeWebSocket(async (c) => {

  let unsubscribe = () => {};
  const unsubscribesByAgent = new Map<string | undefined, () => void>();

  const ensureSubscribed = async (agentId?: string) => {
    if (unsubscribesByAgent.has(agentId)) {
      return;
    }

    const agentUnsubscribe = await agentRegistry.subscribe(agentId, (event) => {
      sendEvent(wsRef, event, agentId);
    });
    unsubscribesByAgent.set(agentId, agentUnsubscribe);
  };

  let wsRef: WSContext;

  return {
    onOpen: async (event, ws) => {
      wsRef = ws;
      await ensureSubscribed(undefined);
      unsubscribe = () => {
        for (const agentUnsubscribe of unsubscribesByAgent.values()) {
          agentUnsubscribe();
        }
        unsubscribesByAgent.clear();
      };
    },
    onMessage: async (event, ws) => {
      wsRef = ws;
      try {
        const parsedRequest = websocketRequestSchema.safeParse(JSON.parse(event.data.toString()));
        if (!parsedRequest.success) {
          sendEvent(ws, {
            type: "request.error",
            message: "Invalid websocket request",
            issues: parsedRequest.error.issues,
          }, undefined);
          return;
        }

        const data = parsedRequest.data;
        try {
          if (data.type === "mcp_registry") {
            agentRegistry.setExternalMcpRegistry(data.mcpServers);
          } else if (data.type === "abort") {
            await ensureSubscribed(data.agentId);
            await agentRegistry.abort(data.agentId);
          } else if (data.type === "prompt") {
            await ensureSubscribed(data.agentId);
            await agentRegistry.prompt(data.agentId, data.message);
          }
        } catch (err) {
          sendEvent(ws, {
            type: "request.error",
            message: err instanceof Error ? err.message : String(err),
            issues: [],
          }, "agentId" in data ? data.agentId : undefined);
        }
      } catch (err) {
        console.error("Error handling message:", err);
      }
    },
    onClose: () => {
      unsubscribe();
    }
  };
}));

app.use("*", async (c) => {
  return c.text("Not found", 404);
});

const wss = new WebSocketServer({ noServer: true });
serve({
  fetch: app.fetch,
  port: 80,
  websocket: {
    server: wss,
  },
}, info => {
  console.log(`Server running on port ${info.port}`);
});
