import { serve, upgradeWebSocket } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { ThreadEvent } from "@openai/codex-sdk";
import { Hono } from "hono";
import { WSContext } from "hono/ws";
import { WebSocketServer } from "ws";
import { z } from "zod";

import { getMainAgent, optionsWithMcpServers, PromptOptions, promptOptionsSchema } from "./agent";
import { serveSubagentMcp, subagentMcpServerConfig } from "./subagents";

serveSubagentMcp();

const agent = getMainAgent();
const app = new Hono();

const websocketRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("abort"),
  }),
  z.object({
    type: z.literal("prompt"),
    message: z.string(),
  }),
  z.object({
    type: z.literal("config"),
    config: promptOptionsSchema,
  })
]);

type WebsocketEvent = ThreadEvent | {
  type: "request.error";
  message: string;
  issues: any[];
}

function sendEvent(ws: WSContext, event: WebsocketEvent) {
  ws.send(JSON.stringify(event));
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
  let promptOptions: PromptOptions = {};

  return {
    onOpen: async (event, ws) => {
      unsubscribe = agent.subscribe((event) => {
        sendEvent(ws, event);
      });
    },
    onMessage: (event, ws) => {
      try {
        const parsedRequest = websocketRequestSchema.safeParse(JSON.parse(event.data.toString()));
        if (!parsedRequest.success) {
          sendEvent(ws, {
            type: "request.error",
            message: "Invalid websocket request",
            issues: parsedRequest.error.issues,
          });
          return;
        }

        const data = parsedRequest.data;
        if (data.type === "abort") {
          agent.abort();
        } else if (data.type === "prompt") {
          agent.prompt(data.message, optionsWithMcpServers(promptOptions, {
            subagents: subagentMcpServerConfig(),
          }));
        } else if (data.type === "config") {
          promptOptions = data.config;
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
