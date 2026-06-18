import fs from "fs/promises";
import path from "path";
import { randomBytes, timingSafeEqual } from "crypto";

import { upgradeWebSocket } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";

import type { Agent } from "../../agent";
import { Tool } from "../base";
import type { MiddlewareHandler } from "hono";
import z from "zod";

export type LoginAuthUser = {
  username: string;
  password: string;
};

export interface ChatFrontendToolOptions {
  loginAuth?: {
    // Environment-based configuration can use JSON.parse(process.env.CHAT_LOGIN_USERS!).
    users: LoginAuthUser | LoginAuthUser[];
    sessionSecret?: string;
  };
}

const defaultOptions: ChatFrontendToolOptions = {
};

const SESSION_COOKIE_NAME = "chat_session";
const SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60;

const chatEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export class ChatFrontendTool extends Tool {
  constructor(options: ChatFrontendToolOptions = defaultOptions) {
    const auth = createLoginAuth(options);

    super((server, agent) => {
      if (auth) {
        server.get("/chat/login", async (c) => {
          const session = await readAuthorizedSession(c, auth);
          if (session) {
            return c.redirect("/chat");
          }

          const loginHtmlPath = path.join(import.meta.dirname, "login.html");
          const loginHtml = await fs.readFile(loginHtmlPath, "utf-8");
          return c.html(loginHtml);
        });

        server.post("/chat/login", async (c) => {
          const body = await c.req.parseBody();
          const username = typeof body.username === "string" ? body.username : "";
          const password = typeof body.password === "string" ? body.password : "";
          const user = auth.users.find((candidate) =>
            safeStringEqual(candidate.username, username) &&
            safeStringEqual(candidate.password, password)
          );

          if (!user) {
            logLoginAttempt(c, username, "failed");
            return c.redirect("/chat/login?error=invalid", 303);
          }

          await setSignedCookie(
            c,
            SESSION_COOKIE_NAME,
            encodeSession({
              username: user.username,
              expiresAt: Date.now() + SESSION_DURATION_SECONDS * 1000,
            }),
            auth.sessionSecret,
            getSessionCookieOptions(c),
          );
          logLoginAttempt(c, username, "succeeded");
          return c.redirect("/chat", 303);
        });

        server.post("/chat/logout", (c) => {
          deleteCookie(c, SESSION_COOKIE_NAME, getSessionCookieOptions(c));
          return c.redirect("/chat/login", 303);
        });
      }

      const pageAuthMiddleware = getAuthMiddleware(auth, "page");
      const apiAuthMiddleware = getAuthMiddleware(auth, "api");

      server.use("/chat", pageAuthMiddleware);
      server.get("/chat", async (c) => {
        const chatHtmlPath = path.join(import.meta.dirname, "chat.html");
        const chatHtml = await fs.readFile(chatHtmlPath, "utf-8");
        return c.html(chatHtml);
      });

      server.use("/chat/events", apiAuthMiddleware);
      server.get("/chat/events", async (c) => {
        const query = chatEventsQuerySchema.parse({
          limit: c.req.query("limit") ?? undefined,
          offset: c.req.query("offset") ?? undefined,
        });

        return c.json({
          events: agent.listEvents(query.limit, query.offset).reverse(),
          limit: query.limit,
          offset: query.offset,
        });
      });

      // TODO: Add an explicit allowedOrigins option before enforcing WebSocket Origin checks.
      server.use("/chat/ws", apiAuthMiddleware);
      server.get("/chat/ws", upgradeWebSocket(async (c) => {
        const username = c.get("username") as string | undefined ?? null;

        let unsubscribe = () => {};

        return {
          onOpen: async (event, ws) => {
            unsubscribe = agent.subscribe((event) => {
              ws.send(JSON.stringify(event));
            });
          },
          onMessage: async (event, ws) => {
            const message = event.data.toString();
            handleWsMessage(message, username, agent);
          },
          onClose: async (event, ws) => {
            unsubscribe();
          },
          onError: async (event, ws) => {
            console.error("WebSocket error:", event);
          }
        }
      }));
    });
  }
}

type LoginAuth = {
  users: LoginAuthUser[];
  sessionSecret: string;
};

type ChatSession = {
  username: string;
  expiresAt: number;
};

function createLoginAuth(options: ChatFrontendToolOptions): LoginAuth | null {
  if (!options.loginAuth) {
    return null;
  }

  const users = Array.isArray(options.loginAuth.users)
    ? options.loginAuth.users
    : [options.loginAuth.users];

  if (users.length === 0) {
    throw new Error("ChatFrontendTool loginAuth.users must contain at least one user");
  }

  const usernames = new Set<string>();
  for (const user of users) {
    if (
      !user ||
      typeof user.username !== "string" ||
      typeof user.password !== "string" ||
      !user.username ||
      !user.password
    ) {
      throw new Error("ChatFrontendTool login users must have non-empty usernames and passwords");
    }
    if (usernames.has(user.username)) {
      throw new Error(`ChatFrontendTool loginAuth.users contains duplicate username: ${user.username}`);
    }
    usernames.add(user.username);
  }

  const configuredSecret = options.loginAuth.sessionSecret;
  if (configuredSecret !== undefined && configuredSecret.length === 0) {
    throw new Error("ChatFrontendTool loginAuth.sessionSecret cannot be empty");
  }

  return {
    users,
    sessionSecret: configuredSecret ?? randomBytes(32).toString("base64url"),
  };
}

function getAuthMiddleware(auth: LoginAuth | null, mode: "page" | "api"): MiddlewareHandler {
  if (!auth) {
    return async (c, next) => {
      await next();
    };
  }

  return async (c, next) => {
    const session = await readAuthorizedSession(c, auth);
    if (!session) {
      if (mode === "page") {
        return c.redirect("/chat/login");
      }
      return c.json({ error: "Unauthorized" }, 401);
    }

    c.set("username", session.username);
    await next();
  };
}

function logLoginAttempt(
  c: Parameters<typeof getSignedCookie>[0],
  username: string,
  outcome: "succeeded" | "failed",
) {
  const forwardedFor = c.req.header("x-forwarded-for")?.split(",", 1)[0]?.trim();
  const remoteAddress = getConnInfo(c).remote.address ?? "unknown";

  console.info(JSON.stringify({
    event: "chat.login_attempt",
    username,
    remoteAddress,
    forwardedFor: forwardedFor ?? null,
    outcome,
  }));
}

async function readAuthorizedSession(
  c: Parameters<typeof getSignedCookie>[0],
  auth: LoginAuth,
): Promise<ChatSession | null> {
  const session = await readSession(c, auth.sessionSecret);
  if (!session || !auth.users.some((user) => user.username === session.username)) {
    return null;
  }
  return session;
}

async function readSession(c: Parameters<typeof getSignedCookie>[0], secret: string): Promise<ChatSession | null> {
  const value = await getSignedCookie(c, secret, SESSION_COOKIE_NAME);
  if (typeof value !== "string") {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ChatSession>;
    if (
      typeof session.username !== "string" ||
      !session.username ||
      typeof session.expiresAt !== "number" ||
      !Number.isFinite(session.expiresAt) ||
      session.expiresAt <= Date.now()
    ) {
      return null;
    }
    return session as ChatSession;
  } catch {
    return null;
  }
}

function encodeSession(session: ChatSession): string {
  return Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  const size = Math.max(leftBuffer.length, rightBuffer.length, 1);
  const paddedLeft = Buffer.alloc(size);
  const paddedRight = Buffer.alloc(size);
  leftBuffer.copy(paddedLeft);
  rightBuffer.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && leftBuffer.length === rightBuffer.length;
}

function getSessionCookieOptions(c: Parameters<typeof getSignedCookie>[0]) {
  const forwardedProto = c.req.header("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  const secure = c.req.url.startsWith("https://") || forwardedProto === "https";
  return {
    path: "/chat",
    httpOnly: true,
    secure,
    sameSite: "Lax" as const,
    maxAge: SESSION_DURATION_SECONDS,
  };
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
