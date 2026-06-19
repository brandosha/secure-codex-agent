import { createHmac, timingSafeEqual } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/server";
import type { Context } from "hono";
import { z } from "zod";

import type { Agent } from "../agent";
import type { AnyTool } from "./base";
import { mcpTool, webhookTool } from "./base";
import { mcpTextResult, redactSecrets } from "../utils";

const TRELLO_MCP_CLIENT_IDENTIFIER = "TrelloMcpTool";
const TRELLO_WEBHOOK_SOURCE = "trello/webhook";

export interface TrelloToolOptions {
  apiKey: string;
  token: string;
  secret?: string;
  originHostname?: string;
}

interface TrelloSharedState {
  webhook?: {
    callbackUrl: string;
    secret: string;
  };
  currentMemberIdPromise: Promise<string>;
}

interface TrelloWebhook {
  id: string;
  idModel: string;
  callbackURL: string;
}

interface TrelloCard {
  id?: string;
  name?: string;
  idBoard?: string;
  idList?: string;
  idMembers?: string[];
}

interface TrelloBoard {
  id?: string;
  name?: string;
  idOrganization?: string | null;
}

interface TrelloList {
  name?: string;
}

interface TrelloOrganization {
  displayName?: string;
}

interface TrelloWebhookAction {
  data?: {
    card?: {
      id?: string;
      name?: string;
    };
  };
  [key: string]: unknown;
}

interface TrelloWebhookPayload {
  action?: TrelloWebhookAction;
  model?: TrelloBoard;
}

export function trelloTool(options: TrelloToolOptions) {
  const state: TrelloSharedState = {
    currentMemberIdPromise: getCurrentMemberId(options),
    webhook: buildTrelloWebhookConfig(options),
  };

  const tools: AnyTool[] = [mcpTool("trello", createTrelloMcpServer(options, state))];
  if (state.webhook) {
    tools.push(webhookTool(
      "trello",
      (c, agent) => handleTrelloWebhookRequest(c, agent, options, {
        ...state.webhook!,
        currentMemberIdPromise: state.currentMemberIdPromise,
      }),
    ));
  }

  return tools;
}

function buildTrelloWebhookConfig(options: TrelloToolOptions) {
  if (!options.originHostname) {
    return undefined;
  }

  if (!options.secret) {
    throw new Error("Trello webhook secret must be configured when the origin hostname is configured.");
  }

  return {
    callbackUrl: buildTrelloWebhookCallbackUrl(options.originHostname),
    secret: options.secret,
  };
}

function createTrelloMcpServer(options: TrelloToolOptions, state: TrelloSharedState) {
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
        apiKey: options.apiKey,
        token: options.token,
        method: input.method,
        endpoint: input.endpoint,
        currentMemberIdPromise: state.currentMemberIdPromise,
      });

      const response = await makeTrelloApiRequest({
        method: input.method,
        endpoint: input.endpoint,
        body: input.body,
        apiKey: options.apiKey,
        token: options.token,
        clientIdentifier: TRELLO_MCP_CLIENT_IDENTIFIER,
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
      const currentMemberId = await state.currentMemberIdPromise;
      const response = await makeTrelloApiRequest({
        method: "POST",
        endpoint: "/cards",
        body: buildCreateCardBody(input.body, currentMemberId),
        apiKey: options.apiKey,
        token: options.token,
        clientIdentifier: TRELLO_MCP_CLIENT_IDENTIFIER,
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

  if (state.webhook) {
    mcp.registerTool("add_trello_webhook", {
      description: "Register this agent's Trello webhook for a Trello resource unless it is already registered.",
      inputSchema: z.object({
        resourceId: z.string().trim().min(1),
      }),
    }, async ({ resourceId }) => {
      try {
        const webhooks = await listTrelloWebhooks(options);
        const existing = webhooks.find((webhook) =>
          webhook.idModel === resourceId
          && webhook.callbackURL === state.webhook!.callbackUrl
        );

        if (existing) {
          return mcpTextResult(`Trello webhook is already registered: ${JSON.stringify(existing)}`);
        }

        const webhook = await makeTrelloApiRequest({
          method: "POST",
          endpoint: "/webhooks",
          body: {
            idModel: resourceId,
            description: `Secure Codex Agent: ${resourceId}`,
            callbackURL: state.webhook!.callbackUrl,
          },
          apiKey: options.apiKey,
          token: options.token,
          clientIdentifier: TRELLO_MCP_CLIENT_IDENTIFIER,
        }) as TrelloWebhook;

        return mcpTextResult(`Registered Trello webhook: ${JSON.stringify(webhook)}`);
      } catch (err) {
        return mcpTextResult(
          `Failed to register Trello webhook: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    });
  }

  return mcp;
}

export function buildTrelloWebhookCallbackUrl(originHostname: string) {
  if (typeof originHostname !== "string") {
    throw new Error("Trello webhook origin hostname must be configured.");
  }

  const normalizedHostname = originHostname
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");

  if (!normalizedHostname || normalizedHostname.includes("/")) {
    throw new Error("Trello webhook origin hostname must be a hostname, optionally with a port.");
  }

  return `https://${normalizedHostname}/webhook/trello`;
}

export function verifyTrelloWebhookSignature(params: {
  body: string;
  callbackUrl: string;
  secret: string;
  signature: string | undefined;
}) {
  if (!params.signature) {
    return false;
  }

  const expectedSignature = createHmac("sha1", params.secret)
    .update(params.body)
    .update(params.callbackUrl)
    .digest();
  const receivedSignature = Buffer.from(params.signature, "base64");

  return receivedSignature.length === expectedSignature.length
    && timingSafeEqual(receivedSignature, expectedSignature);
}

async function listTrelloWebhooks(options: TrelloToolOptions) {
  const response = await makeTrelloApiRequest({
    method: "GET",
    endpoint: `/tokens/${options.token}/webhooks`,
    apiKey: options.apiKey,
    token: options.token,
    clientIdentifier: TRELLO_MCP_CLIENT_IDENTIFIER,
  });

  return Array.isArray(response) ? response as TrelloWebhook[] : [];
}

async function handleTrelloWebhookRequest(
  c: Context,
  agent: Agent,
  options: TrelloToolOptions,
  webhook: NonNullable<TrelloSharedState["webhook"]> & {
    currentMemberIdPromise: Promise<string>;
  },
) {
  if (c.req.method === "HEAD") {
    return c.text("OK", 200);
  }

  if (c.req.method !== "POST") {
    return c.text("Method Not Allowed", 405);
  }

  const bodyText = await c.req.text();
  if (!verifyTrelloWebhookSignature({
    body: bodyText,
    callbackUrl: webhook.callbackUrl,
    secret: webhook.secret,
    signature: c.req.header("x-trello-webhook"),
  })) {
    return c.text("Unauthorized", 401);
  }

  try {
    const payload = JSON.parse(bodyText) as TrelloWebhookPayload;
    const clientIdentifier = c.req.header("x-trello-client-identifier");

    if (clientIdentifier === TRELLO_MCP_CLIENT_IDENTIFIER) {
      return c.text("OK", 200);
    }

    const cardId = payload.action?.data?.card?.id;
    if (!cardId) {
      console.warn("Trello webhook does not contain card information, skipping");
      return c.text("OK", 200);
    }

    const [currentMemberId, card] = await Promise.all([
      webhook.currentMemberIdPromise,
      makeTrelloApiRequest({
        method: "GET",
        endpoint: `/cards/${cardId}?fields=name,idBoard,idList,idMembers`,
        apiKey: options.apiKey,
        token: options.token,
        clientIdentifier: "TrelloWebhookTool",
      }) as Promise<TrelloCard>,
    ]);

    if (!card.idMembers?.includes(currentMemberId)) {
      console.log(`Trello card ${cardId} is not assigned to the current member, skipping`);
      return c.text("OK", 200);
    }

    const [list, board] = await Promise.all([
      card.idList
        ? makeTrelloApiRequest({
            method: "GET",
            endpoint: `/lists/${card.idList}?fields=name`,
            apiKey: options.apiKey,
            token: options.token,
            clientIdentifier: "TrelloWebhookTool",
          }) as Promise<TrelloList>
        : Promise.resolve({} as TrelloList),
      card.idBoard
        ? makeTrelloApiRequest({
            method: "GET",
            endpoint: `/boards/${card.idBoard}?fields=name,idOrganization`,
            apiKey: options.apiKey,
            token: options.token,
            clientIdentifier: "TrelloWebhookTool",
          }) as Promise<TrelloBoard>
        : Promise.resolve(payload.model ?? {}),
    ]);

    const organization = board.idOrganization
      ? await makeTrelloApiRequest({
          method: "GET",
          endpoint: `/organizations/${board.idOrganization}?fields=displayName`,
          apiKey: options.apiKey,
          token: options.token,
          clientIdentifier: "TrelloWebhookTool",
        }) as TrelloOrganization
      : undefined;

    const cardName = card.name ?? payload.action?.data?.card?.name ?? cardId;
    const listName = list.name ?? "unknown";
    const boardName = board.name ?? payload.model?.name ?? "unknown";
    const orgName = organization?.displayName ?? "none";

    agent.prompt([
      `Trello action for card "${cardName}" in list "${listName}" on board "${boardName}" in organization "${orgName}":`,
      `X-Trello-Client-Identifier: ${clientIdentifier ?? "none"}`,
      JSON.stringify(payload.action),
      "",
      "Next steps:",
      "- Analyze the action and determine what, if anything, needs to be done in response based on the card's current state and project guidelines.",
    ].join("\n"), TRELLO_WEBHOOK_SOURCE);
  } catch (error) {
    console.error(
      `Error handling Trello webhook: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return c.text("OK", 200);
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
  endpoint = endpoint.trim();
  if (!endpoint) {
    throw new TrelloAuthorizationError("Trello endpoint cannot be empty.");
  }

  // Remove the origin from the endpoint
  endpoint = endpoint.replace(/^https?:\/\/[^/]+/i, "");
  if (!endpoint.startsWith("/")) endpoint = `/${endpoint}`;
  if (!endpoint.startsWith("/1")) endpoint = `/1${endpoint}`;
  
  return endpoint;
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
    clientIdentifier: TRELLO_MCP_CLIENT_IDENTIFIER,
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
    clientIdentifier: TRELLO_MCP_CLIENT_IDENTIFIER,
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

  const url = new URL(`${endpoint}`, "https://api.trello.com");

  const options: RequestInit = {
    method: request.method,
    headers: {
      "Authorization": `OAuth oauth_consumer_key="${apiKey}", oauth_token="${token}"`,
      "Content-Type": "application/json",
      "X-Trello-Client-Identifier": clientIdentifier,
    },
  };

  if (request.body) {
    if (request.method === "GET") {
      Object.entries(request.body).forEach(([key, value]) => {
        url.searchParams.set(key, String(value));
      });
    } else {
      options.body = JSON.stringify(request.body);
    }
  }

  const response = await fetch(url.toString(), options).catch((error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecrets(
      `Error fetching Trello API: ${errorMessage}`,
      [apiKey, token]
    ));
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(redactSecrets(
      `Trello API request failed: ${response.status} ${response.statusText}\n${errorText}`,
      [apiKey, token],
    ));
  }

  if (response.status === 204) {
    return null;
  }

  const responseText = await response.text();
  if (!responseText.trim()) {
    return null;
  }

  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
}
