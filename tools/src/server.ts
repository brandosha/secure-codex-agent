import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";

// export const server = new Hono<{ Variables: Record<string, unknown> }>();
export type Server = Hono<{ Variables: Record<string, unknown> }>;

export function newServer() {
  return new Hono<{ Variables: Record<string, unknown> }>();
}

interface StartServerOptions {
  port: number;
  enableWebsocket: boolean;
}
export function startServer(server: Hono, options: StartServerOptions) {
  server.use("*", async (c) => {
    return c.text("Not found", 404);
  });

  const websocket = options.enableWebsocket ? {
    server: new WebSocketServer({ noServer: true })
  } : undefined;

  serve({
    fetch: server.fetch,
    websocket,
    port: options.port,
  }, info => {
    console.log(`Server running on port ${info.port}`);
  });
}

