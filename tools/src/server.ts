import { serve } from "@hono/node-server";
import { Hono } from "hono";

export const server = new Hono();


export function startServer() {
  server.use("*", async (c) => {
    return c.text("Not found", 404);
  });

  serve({
    fetch: server.fetch,
    port: 80,
  }, info => {
    console.log(`Server running on port ${info.port}`);
  });
}

