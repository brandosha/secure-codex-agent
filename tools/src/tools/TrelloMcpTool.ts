import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { McpTool } from "./base";

export class TrelloMcpTool extends McpTool {
  constructor() {
    super("trello", trelloMcpServerBuilder);
  }
}

function trelloMcpServerBuilder() {
  const { TRELLO_API_KEY, TRELLO_TOKEN } = process.env;

  if (!TRELLO_API_KEY || !TRELLO_TOKEN) {
    throw new Error("TRELLO_API_KEY and TRELLO_TOKEN environment variables must be set");
  }

  const currentMemberIdPromise = getCurrentMemberId({
    apiKey: TRELLO_API_KEY,
    token: TRELLO_TOKEN,
  });

  const mcp = new McpServer({
    name: "Trello MCP Tool",
    version: "0.0.1",
  });

  mcp.registerTool("trello_api", {
    description: "Tool for interacting with Trello boards, lists, and cards.",
    inputSchema: z.object({
      endpoint: z.string(),
      method: z.enum(["GET", "POST", "PUT", "DELETE"]),
      body: z.record(z.string(), z.any()).optional(),
    }),
  }, async (input) => {
    try {
      await authorizeTrelloRequest({
        apiKey: TRELLO_API_KEY,
        token: TRELLO_TOKEN,
        method: input.method,
        endpoint: input.endpoint,
        currentMemberIdPromise,
      });

      const response = await makeTrelloApiRequest({
        method: input.method,
        endpoint: input.endpoint,
        body: input.body,
        apiKey: TRELLO_API_KEY,
        token: TRELLO_TOKEN,
        clientIdentifier: "TrelloMcpTool",
      });

      return {
        isError: false,
        content: [{
          type: "resource",
          resource: {
            uri: "trello-api-response.json",
            mimeType: "application/json",
            text: JSON.stringify(response),
          },
        }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: "Failed to make Trello API request",
        }, {
          type: "text",
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    }
  });

  mcp.registerTool("trello_create_card", {
    description: "Create a Trello card assigned to the current Trello user.",
    inputSchema: z.object({
      body: z.record(z.string(), z.any()),
    }),
  }, async (input) => {
    try {
      const currentMemberId = await currentMemberIdPromise;
      const response = await makeTrelloApiRequest({
        method: "POST",
        endpoint: "/cards",
        body: buildCreateCardBody(input.body, currentMemberId),
        apiKey: TRELLO_API_KEY,
        token: TRELLO_TOKEN,
        clientIdentifier: "TrelloMcpTool",
      });

      return {
        isError: false,
        content: [{
          type: "resource",
          resource: {
            uri: "trello-api-response.json",
            mimeType: "application/json",
            text: JSON.stringify(response),
          },
        }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: "Failed to create Trello card",
        }, {
          type: "text",
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    }
  });

  return mcp;
}

export const TRELLO_CLIENT_IDENTIFIER = "TrelloAgent";

interface TrelloApiRequest {
  apiKey: string;
  token: string;
  method: string;
  endpoint: string;
  body?: any;
  clientIdentifier?: string;
}

interface TrelloAuthRequest {
  apiKey: string;
  token: string;
  method: TrelloMethod;
  endpoint: string;
  currentMemberIdPromise: Promise<string>;
}

interface TrelloCardMembersResponse {
  idMembers?: string[];
}

interface TrelloMemberResponse {
  id?: string;
}

type TrelloMethod = "GET" | "POST" | "PUT" | "DELETE";

export class TrelloAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrelloAuthorizationError";
  }
}

type TrelloEndpointPolicy =
  | { kind: "readonly" }
  | { kind: "comment"; cardId: string }
  | { kind: "card-write"; cardId: string };

export function classifyTrelloRequest(method: TrelloMethod, endpoint: string): TrelloEndpointPolicy {
  if (method === "GET") {
    return { kind: "readonly" };
  }

  const { segments } = parseTrelloEndpoint(endpoint);
  if (method === "POST" && segments.length === 1 && segments[0] === "cards") {
    throw new TrelloAuthorizationError("Card creation via trello_api is blocked. Use trello_create_card instead.");
  }

  if (segments.length < 2 || segments[0] !== "cards" || !segments[1]) {
    throw new TrelloAuthorizationError("Mutating Trello requests are only allowed for card endpoints.");
  }

  const cardId = segments[1];
  if (method === "POST" && segments.length === 4 && segments[2] === "actions" && segments[3] === "comments") {
    return { kind: "comment", cardId };
  }

  return { kind: "card-write", cardId };
}

export function parseTrelloEndpoint(endpoint: string) {
  const normalized = normalizeTrelloEndpoint(endpoint);
  const url = new URL(normalized, "https://api.trello.com");
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments[0] === "1") {
    segments.shift();
  }

  return {
    endpoint: normalized,
    segments,
  };
}

export function normalizeTrelloEndpoint(endpoint: string) {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    throw new TrelloAuthorizationError("Trello endpoint cannot be empty.");
  }

  const withoutOrigin = trimmed.replace(/^https?:\/\/[^/]+/i, "");
  return withoutOrigin.startsWith("/") ? withoutOrigin : `/${withoutOrigin}`;
}

export async function authorizeTrelloRequest(request: TrelloAuthRequest) {
  const policy = classifyTrelloRequest(request.method, request.endpoint);
  if (policy.kind === "readonly" || policy.kind === "comment") {
    return policy;
  }

  let currentMemberId: string;
  try {
    currentMemberId = await request.currentMemberIdPromise;
  } catch (error) {
    throw new TrelloAuthorizationError(
      `Unable to resolve current Trello member identity: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const isAssigned = await isCardAssignedToMember({
    apiKey: request.apiKey,
    token: request.token,
    cardId: policy.cardId,
    memberId: currentMemberId,
  });

  if (!isAssigned) {
    throw new TrelloAuthorizationError(
      `Card ${policy.cardId} is not assigned to the current Trello user, so this mutation is blocked.`,
    );
  }

  return policy;
}

export async function getCurrentMemberId(credentials: { apiKey: string; token: string }) {
  const response = await makeTrelloApiRequest({
    apiKey: credentials.apiKey,
    token: credentials.token,
    method: "GET",
    endpoint: "/members/me?fields=id",
    clientIdentifier: "TrelloMcpTool",
  }) as TrelloMemberResponse;

  if (!response.id) {
    throw new Error("Trello members/me response did not include an id.");
  }

  return response.id;
}

export async function isCardAssignedToMember(params: {
  apiKey: string;
  token: string;
  cardId: string;
  memberId: string;
}) {
  const response = await makeTrelloApiRequest({
    apiKey: params.apiKey,
    token: params.token,
    method: "GET",
    endpoint: `/cards/${params.cardId}?fields=idMembers`,
    clientIdentifier: "TrelloMcpTool",
  }) as TrelloCardMembersResponse;

  return response.idMembers?.includes(params.memberId) ?? false;
}

export function buildCreateCardBody(body: Record<string, any>, currentMemberId: string) {
  return {
    ...body,
    idMembers: mergeMemberIds(body.idMembers, currentMemberId),
  };
}

export function mergeMemberIds(idMembers: unknown, currentMemberId: string) {
  const normalizedMembers = normalizeMemberIds(idMembers);
  if (normalizedMembers.includes(currentMemberId)) {
    return normalizedMembers;
  }

  return [...normalizedMembers, currentMemberId];
}

function normalizeMemberIds(idMembers: unknown) {
  if (typeof idMembers === "string") {
    return idMembers ? [idMembers] : [];
  }

  if (Array.isArray(idMembers)) {
    return idMembers
      .filter((memberId): memberId is string => typeof memberId === "string" && memberId.length > 0);
  }

  return [];
}

export async function makeTrelloApiRequest(request: TrelloApiRequest) {
  const { token, apiKey } = request;
  const clientIdentifier = request.clientIdentifier ?? TRELLO_CLIENT_IDENTIFIER;
  const endpoint = normalizeTrelloEndpoint(request.endpoint);

  const url = new URL(`/1${endpoint}`, "https://api.trello.com");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("token", token);

  const options: RequestInit = {
    method: request.method,
    headers: {
      "Content-Type": "application/json",
      "X-Trello-Client-Identifier": clientIdentifier,
    },
  };

  if (request.body) {
    options.body = JSON.stringify(request.body);
  }

  const response = await fetch(url.toString(), options);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Trello API request failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  return await response.json();
}
