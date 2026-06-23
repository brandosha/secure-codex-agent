import { serve, upgradeWebSocket } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { ThreadEvent } from "@openai/codex-sdk";
import { Hono } from "hono";
import { WSContext } from "hono/ws";
import { WebSocketServer } from "ws";
import { z } from "zod";

import { AgentRegistry } from "./agentRegistry";
import { PromptOptions, promptOptionsSchema } from "./agent";
import { serveSubagentMcp } from "./subagents";

serveSubagentMcp();

const agentRegistry = new AgentRegistry();
const app = new Hono();

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
    type: z.literal("config"),
    agentId: z.string().optional(),
    config: promptOptionsSchema,
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
  const promptOptionsByAgent = new Map<string | undefined, PromptOptions>();

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
          await ensureSubscribed(data.agentId);
          if (data.type === "abort") {
            await agentRegistry.abort(data.agentId);
          } else if (data.type === "prompt") {
            const promptOptions = promptOptionsByAgent.get(data.agentId) ?? {};
            await agentRegistry.prompt(data.agentId, data.message, promptOptions);
          } else if (data.type === "config") {
            promptOptionsByAgent.set(data.agentId, data.config);
          }
        } catch (err) {
          sendEvent(ws, {
            type: "request.error",
            message: err instanceof Error ? err.message : String(err),
            issues: [],
          }, data.agentId);
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
