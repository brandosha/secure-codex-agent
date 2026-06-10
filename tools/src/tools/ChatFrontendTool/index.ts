import { upgradeWebSocket } from "@hono/node-server";

import { Chat } from "./chat";
import { Tool } from "../../tools";

interface ChatFrontendToolOptions {
  // Define any options for the ChatFrontendTool here
}

const defaultOptions: ChatFrontendToolOptions = {
  // Set default values for options here
};

export class ChatFrontendTool extends Tool {
  constructor(options: ChatFrontendToolOptions = defaultOptions) {
    super((server, agent) => {
      server.get("/chat/ws", upgradeWebSocket(async (c) => {
        return {
          onOpen: async (ws) => {
            console.log("WebSocket connection opened");
          },
          onMessage: async (ws, message) => {
            console.log("Received message:", message);
            // Handle incoming chat messages here
          },
          onClose: async (ws) => {
            console.log("WebSocket connection closed");
          },
          onError: async (ws, error) => {
            console.error("WebSocket error:", error);
          }
        }
      }));

      server.get("/chat", (c) => {
        console.log("Serving chat frontend");
        return c.html(Chat());
      });

      console.log("ChatFrontendTool registered");
    });
  }
}