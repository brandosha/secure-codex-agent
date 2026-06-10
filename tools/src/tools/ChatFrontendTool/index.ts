import fs from "fs/promises";
import path from "path";

import { upgradeWebSocket } from "@hono/node-server";
import { basicAuth } from "hono/basic-auth";

import type { Agent } from "../../agent";
import { Tool } from "../base";
import type { MiddlewareHandler } from "hono";
import z from "zod";

type BasicAuthUser = {
  username: string;
  password: string;
};
interface ChatFrontendToolOptions {
  // Define any options for the ChatFrontendTool here
  basicAuth?: BasicAuthUser | BasicAuthUser[]; // Optional basic auth credentials for accessing the chat frontend
}

const defaultOptions: ChatFrontendToolOptions = {
  // Set default values for options here
};

export class ChatFrontendTool extends Tool {
  constructor(options: ChatFrontendToolOptions = defaultOptions) {
    super((server, agent) => {
      let authMiddleware = getAuthMiddleware(options);

      server.use("/chat", authMiddleware);
      server.get("/chat", async (c) => {
        const chatHtmlPath = path.join(import.meta.dirname, "chat.html");
        const chatHtml = await fs.readFile(chatHtmlPath, "utf-8");
        return c.html(chatHtml);
      });


      const chatWsTokens = new Map<string, string | null>();

      server.use("/chat/ws-token", authMiddleware);
      server.get("/chat/ws-token", async (c) => {
        const token = crypto.randomUUID();

        const username = c.get("username") as string | undefined ?? null;
        chatWsTokens.set(token, username);
        setTimeout(() => chatWsTokens.delete(token), 5 * 1000); // Token expires after 5 seconds
        return c.json({ token });
      });

      server.get("/chat/ws", upgradeWebSocket(async (c) => {
        const token = c.req.query("token");
        if (!token) {
          throw new Error("Missing token");
        }

        const username = chatWsTokens.get(token);
        if (username === undefined) {
          throw new Error("Invalid WebSocket token");
        }
        chatWsTokens.delete(token);

        let unsubscribe = () => {};

        return {
          onOpen: async (event, ws) => {
            console.log("WebSocket connection opened");
            unsubscribe = agent.subscribe((event) => {
              ws.send(JSON.stringify(event));
            });
          },
          onMessage: async (event, ws) => {
            const message = event.data.toString();
            console.log("Received message:", message);
            handleWsMessage(message, username, agent);
          },
          onClose: async (event, ws) => {
            console.log("WebSocket connection closed");
            unsubscribe();
          },
          onError: async (event, ws) => {
            console.error("WebSocket error:", event);
          }
        }
      }));

      console.log("ChatFrontendTool registered");
    });
  }
}

function getAuthMiddleware(options: ChatFrontendToolOptions): MiddlewareHandler {
  if (!options.basicAuth) {
    return async (c, next) => {
      await next();
    };
  }

  const users = Array.isArray(options.basicAuth) ? options.basicAuth : [options.basicAuth];
  return basicAuth({
    onAuthSuccess(c, username) {
      c.set("username", username);
    },
    ...users[0]
  }, ...users.slice(1));
}

const wsMessageSchema = z.union([
  z.object({
    type: z.literal("prompt"),
    input: z.string()
  }),
  z.object({
    type: z.literal("abort"),
  })
]);

function handleWsMessage(msg: string, username: string | null, agent: Agent) {
  const parsedMessage = JSON.parse(msg);
  const message = wsMessageSchema.parse(parsedMessage);

  const from = username !== null ? `chat/user/${username}` : "chat/user";

  if (message.type === "prompt") {
    agent.prompt(message.input, from);
  } else if (message.type === "abort") {
    agent.abort(from);
  }
}