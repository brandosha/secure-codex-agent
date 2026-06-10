import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";

export const server = new Hono();


export function startServer() {
  server.use("*", async (c) => {
    return c.text("Not found", 404);
  });

  const wss = new WebSocketServer({ noServer: true });

  serve({
    fetch: server.fetch,
    websocket: {
      server: wss,
    },
    port: 80,
  }, info => {
    console.log(`Server running on port ${info.port}`);
  });
}

