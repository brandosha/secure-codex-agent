import { McpServer } from "@modelcontextprotocol/server";
import { SocketModeClient } from "@slack/socket-mode";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";

import { mcpTool, WORKSPACE_PATH } from "../base";
import type { AgentRouter } from "../../agent";
import { redactSecrets } from "../../utils";

interface SlackMcpToolOptions {
  botToken: string;
  appToken?: string;
}

export function slackMcpTool(options: SlackMcpToolOptions) {
  return mcpTool("slack", (agentRouter) => {
    startSlackSocketMode(options, agentRouter);
    return createSlackMcpServer(options);
  });
}

function createSlackMcpServer(options: SlackMcpToolOptions) {
  const mcp = new McpServer({
    name: "Slack MCP Tool",
    version: "0.0.1",
  });

  mcp.registerTool("slack_api", {
    description: "Tool for interacting with Slack Web API methods.",
    inputSchema: z.object({
      endpoint: z.string().describe("Slack Web API method path, for example /chat.postMessage or chat.postMessage."),
      method: z.enum(["GET", "POST"]).default("POST"),
      body: z.record(z.string(), z.any()).optional(),
    }),
  }, async (input) => {
    try {
      const response = await makeSlackApiRequest({
        token: options.botToken,
        method: input.method,
        endpoint: input.endpoint,
        body: input.body,
      });

      return slackJsonResult(response);
    } catch (err) {
      return slackErrorResult("Failed to make Slack API request", err);
    }
  });

  mcp.registerTool("slack_upload_file", {
    description: "Upload a file from the workspace directory and share it to one or more Slack channels.",
    inputSchema: z.object({
      file_path: z.string().describe("Path to a file inside the workspace directory. Relative paths are resolved from the workspace root."),
      channels: z.union([z.string(), z.array(z.string()).min(1)]).describe("Slack channel ID, user ID, or a list of channel/user IDs to share the file with."),
      filename: z.string().optional().describe("Optional filename to show in Slack. Defaults to the disk filename."),
      title: z.string().optional().describe("Optional file title. Defaults to the filename."),
      initial_comment: z.string().optional().describe("Optional message text introducing the file."),
      thread_ts: z.string().optional().describe("Optional parent message timestamp. Slack requires exactly one channel when this is set."),
      alt_txt: z.string().optional().describe("Optional image description for screen readers."),
      snippet_type: z.string().optional().describe("Optional Slack snippet syntax type."),
    }),
  }, async (input) => {
    try {
      const response = await uploadSlackFileFromWorkspace({
        token: options.botToken,
        filePath: input.file_path,
        channels: normalizeSlackChannels(input.channels),
        filename: input.filename,
        title: input.title,
        initialComment: input.initial_comment,
        threadTs: input.thread_ts,
        altTxt: input.alt_txt,
        snippetType: input.snippet_type,
      });

      return slackJsonResult(response);
    } catch (err) {
      return slackErrorResult("Failed to upload Slack file", err);
    }
  });

  return mcp;
}

export const SLACK_CLIENT_IDENTIFIER = "SlackAgent";
export const SLACK_SOCKET_MODE_SOURCE = "slack/socket_mode";

type SlackMethod = "GET" | "POST";

interface SlackSocketModeEventEnvelope {
  ack: () => Promise<void>;
  type: string;
  body?: {
    event?: SlackSocketEvent;
    event_id?: string;
    team_id?: string;
    authorizations?: unknown[];
    [key: string]: unknown;
  };
  retry_num?: number;
  retry_reason?: string;
}

interface SlackSocketEvent {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  channel_type?: string;
  team?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  [key: string]: unknown;
}

interface SlackBotIdentity {
  userId?: string;
  botId?: string;
}

interface SlackApiRequest {
  token: string;
  method: SlackMethod;
  endpoint: string;
  body?: Record<string, any>;
}

interface SlackUploadUrlResponse extends SlackApiResponse {
  upload_url?: string;
  file_id?: string;
}

interface SlackUploadFileRequest {
  token: string;
  filePath: string;
  channels: string[];
  filename?: string;
  title?: string;
  initialComment?: string;
  threadTs?: string;
  altTxt?: string;
  snippetType?: string;
}

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
  needed?: string;
  provided?: string;
  response_metadata?: {
    messages?: string[];
    warnings?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

let slackSocketModeStarted = false;

function startSlackSocketMode(options: SlackMcpToolOptions, agentRouter: AgentRouter) {
  if (!options.appToken || slackSocketModeStarted) {
    return;
  }

  slackSocketModeStarted = true;
  const client = new SocketModeClient({
    appToken: options.appToken,
    autoReconnectEnabled: true,
  });
  const botIdentityPromise = getSlackBotIdentity(options.botToken);

  for (const eventName of ["authenticated", "connected", "reconnecting", "disconnected"]) {
    client.on(eventName, () => {
      console.info(`Slack Socket Mode ${eventName}`);
    });
  }

  client.on("error", (err) => {
    console.error(`Slack Socket Mode error: ${err instanceof Error ? err.message : String(err)}`);
  });

  client.on("slack_event", (envelope: SlackSocketModeEventEnvelope) => {
    void handleSlackSocketModeEvent(envelope, agentRouter, botIdentityPromise);
  });

  void client.start().catch((err) => {
    console.error(`Failed to start Slack Socket Mode: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function getSlackBotIdentity(token: string): Promise<SlackBotIdentity> {
  try {
    const response = await makeSlackApiRequest({
      token,
      method: "POST",
      endpoint: "/auth.test",
    });

    return {
      userId: typeof response.user_id === "string" ? response.user_id : undefined,
      botId: typeof response.bot_id === "string" ? response.bot_id : undefined,
    };
  } catch (err) {
    console.warn(`Unable to resolve Slack bot identity: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

async function handleSlackSocketModeEvent(
  envelope: SlackSocketModeEventEnvelope,
  agentRouter: AgentRouter,
  botIdentityPromise: Promise<SlackBotIdentity>,
) {
  try {
    await envelope.ack();
  } catch (err) {
    console.error(`Failed to ack Slack Socket Mode envelope: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (envelope.type !== "events_api") {
    return;
  }

  const event = envelope.body?.event;
  if (!event) {
    console.warn("Slack Socket Mode events_api envelope did not contain an event.");
    return;
  }

  const botIdentity = await botIdentityPromise;
  if (!shouldPromptForSlackSocketEvent(event, botIdentity)) {
    return;
  }

  agentRouter.agent().prompt(
    formatSlackSocketPrompt(event, envelope),
    SLACK_SOCKET_MODE_SOURCE,
  );
}

export function shouldPromptForSlackSocketEvent(event: SlackSocketEvent, botIdentity: SlackBotIdentity = {}) {
  if (isSlackBotOrSelfEvent(event, botIdentity)) {
    return false;
  }

  if (event.type === "app_mention") {
    return true;
  }

  return event.type === "message" && event.channel_type === "im";
}

function isSlackBotOrSelfEvent(event: SlackSocketEvent, botIdentity: SlackBotIdentity) {
  if (event.bot_id) {
    return true;
  }

  if (event.subtype) {
    return true;
  }

  if (botIdentity.userId && event.user === botIdentity.userId) {
    return true;
  }

  return Boolean(botIdentity.botId && event.bot_id === botIdentity.botId);
}

export function formatSlackSocketPrompt(
  event: SlackSocketEvent,
  envelope?: Pick<SlackSocketModeEventEnvelope, "body" | "retry_num" | "retry_reason">,
) {
  return [
    "New Slack event:",
    JSON.stringify(event),
    "",
    "Next steps:",
    "- Decide whether this needs a response.",
    "- If responding, use the Slack MCP tools and preserve the channel/thread context above.",
  ].join("\n");
}

export class SlackApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackApiError";
  }
}

export function normalizeSlackChannels(channels: string | string[]) {
  const normalizedChannels = (Array.isArray(channels) ? channels : channels.split(","))
    .map(channel => channel.trim())
    .filter(Boolean);

  if (normalizedChannels.length === 0) {
    throw new SlackApiError("At least one Slack channel must be provided.");
  }

  if (normalizedChannels.length > 100) {
    throw new SlackApiError("Slack file uploads can be shared with at most 100 channels.");
  }

  return normalizedChannels;
}

export function resolveWorkspaceFilePath(filePath: string, workspacePath = WORKSPACE_PATH) {
  const workspaceRoot = path.resolve(workspacePath);
  const resolvedPath = path.resolve(workspaceRoot, filePath);
  const relativePath = path.relative(workspaceRoot, resolvedPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new SlackApiError("File path must stay inside the workspace directory.");
  }

  return resolvedPath;
}

export async function uploadSlackFileFromWorkspace(request: SlackUploadFileRequest) {
  if (request.threadTs && request.channels.length !== 1) {
    throw new SlackApiError("Slack file thread uploads require exactly one channel.");
  }

  const resolvedPath = resolveWorkspaceFilePath(request.filePath);
  const stat = await fs.stat(resolvedPath).catch((error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new SlackApiError(`Unable to read workspace file metadata: ${errorMessage}`);
  });

  if (!stat.isFile()) {
    throw new SlackApiError("Slack file upload path must point to a file.");
  }

  if (stat.size === 0) {
    throw new SlackApiError("Slack file upload path must point to a non-empty file.");
  }

  const fileBytes = await fs.readFile(resolvedPath).catch((error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new SlackApiError(`Unable to read workspace file: ${errorMessage}`);
  });

  const filename = request.filename ?? path.basename(resolvedPath);
  const title = request.title ?? filename;
  const uploadTicket = await makeSlackApiFormRequest({
    token: request.token,
    endpoint: "/files.getUploadURLExternal",
    body: {
      filename,
      length: stat.size,
      alt_txt: request.altTxt,
      snippet_type: request.snippetType,
    },
  }) as SlackUploadUrlResponse;

  if (!uploadTicket.upload_url || !uploadTicket.file_id) {
    throw new SlackApiError("Slack upload URL response did not include upload_url and file_id.");
  }

  await uploadSlackFileBytes({
    uploadUrl: uploadTicket.upload_url,
    fileBytes,
    token: request.token,
  });

  return await makeSlackApiFormRequest({
    token: request.token,
    endpoint: "/files.completeUploadExternal",
    body: {
      files: JSON.stringify([{
        id: uploadTicket.file_id,
        title,
      }]),
      initial_comment: request.initialComment,
      thread_ts: request.threadTs,
      channels: request.channels.join(","),
    },
  });
}

export function normalizeSlackEndpoint(endpoint: string) {
  endpoint = endpoint.trim();
  if (!endpoint) {
    throw new SlackApiError("Slack endpoint cannot be empty.");
  }

  const withoutOrigin = endpoint.replace(/^https?:\/\/[^/]+/i, "");
  const withoutApiPrefix = withoutOrigin.replace(/^\/?api\//i, "");
  const normalized = withoutApiPrefix.startsWith("/") ? withoutApiPrefix.slice(1) : withoutApiPrefix;

  if (!normalized) {
    throw new SlackApiError("Slack endpoint cannot be empty.");
  }

  return normalized;
}

export async function makeSlackApiRequest(request: SlackApiRequest) {
  const endpoint = normalizeSlackEndpoint(request.endpoint);
  const url = new URL(`/api/${endpoint}`, "https://slack.com");

  const options: RequestInit = {
    method: request.method,
    headers: {
      "Authorization": `Bearer ${request.token}`,
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": SLACK_CLIENT_IDENTIFIER,
    },
  };

  if (request.body) {
    if (request.method === "GET") {
      Object.entries(request.body).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      });
    } else {
      options.body = JSON.stringify(compactSlackBody(request.body));
    }
  }

  const response = await fetch(url.toString(), options).catch((error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new SlackApiError(redactSecrets(
      `Error fetching Slack API: ${errorMessage}`,
      [request.token],
    ));
  });

  const responseText = await response.text();
  let data: SlackApiResponse;
  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new SlackApiError(redactSecrets(
      `Slack API returned non-JSON response: ${response.status} ${response.statusText}\n${responseText}`,
      [request.token],
    ));
  }

  if (!response.ok || data.ok === false) {
    throw buildSlackApiError({
      response,
      data,
      endpoint,
      token: request.token,
      extraSecrets: [],
      prefix: "Slack API request failed",
    });
  }

  return data;
}

async function makeSlackApiFormRequest(request: {
  token: string;
  endpoint: string;
  body: Record<string, any>;
}) {
  const endpoint = normalizeSlackEndpoint(request.endpoint);
  const url = new URL(`/api/${endpoint}`, "https://slack.com");
  const formBody = new URLSearchParams();

  Object.entries(compactSlackBody(request.body)).forEach(([key, value]) => {
    formBody.set(key, String(value));
  });

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${request.token}`,
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      "User-Agent": SLACK_CLIENT_IDENTIFIER,
    },
    body: formBody,
  }).catch((error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new SlackApiError(redactSecrets(
      `Error fetching Slack API: ${errorMessage}`,
      [request.token],
    ));
  });

  const responseText = await response.text();
  let data: SlackApiResponse;
  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new SlackApiError(redactSecrets(
      `Slack API returned non-JSON response from ${endpoint}: ${response.status} ${response.statusText}\n${responseText}`,
      [request.token],
    ));
  }

  if (!response.ok || data.ok === false) {
    throw buildSlackApiError({
      response,
      data,
      endpoint,
      token: request.token,
      extraSecrets: [],
      prefix: "Slack API request failed",
    });
  }

  return data;
}

function compactSlackBody(body: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined),
  );
}

function buildSlackApiError(params: {
  response: Response;
  data: SlackApiResponse;
  endpoint: string;
  token: string;
  extraSecrets: string[];
  prefix: string;
}) {
  const slackError = params.data.error ? ` Slack error: ${params.data.error}.` : "";
  const scopeDetails = params.data.needed || params.data.provided
    ? ` Needed scopes: ${params.data.needed ?? "unknown"}; provided scopes: ${params.data.provided ?? "unknown"}.`
    : "";
  const metadataMessages = params.data.response_metadata?.messages?.length
    ? ` Messages: ${params.data.response_metadata.messages.join(" ")}`
    : "";
  const metadataWarnings = params.data.response_metadata?.warnings?.length
    ? ` Warnings: ${params.data.response_metadata.warnings.join(" ")}`
    : "";

  return new SlackApiError(redactSecrets(
    `${params.prefix} for ${params.endpoint}: ${params.response.status} ${params.response.statusText}.${slackError}${scopeDetails}${metadataMessages}${metadataWarnings}`,
    [params.token, ...params.extraSecrets],
  ));
}

async function uploadSlackFileBytes(params: {
  uploadUrl: string;
  fileBytes: Buffer;
  token: string;
}) {
  const fileBody = new Uint8Array(params.fileBytes.byteLength);
  fileBody.set(params.fileBytes);

  const response = await fetch(params.uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "User-Agent": SLACK_CLIENT_IDENTIFIER,
    },
    body: new Blob([fileBody]),
  }).catch((error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new SlackApiError(redactSecrets(
      `Error uploading file bytes to Slack: ${errorMessage}`,
      [params.token, params.uploadUrl],
    ));
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new SlackApiError(redactSecrets(
      `Slack file byte upload failed: ${response.status} ${response.statusText}\n${errorText}`,
      [params.token, params.uploadUrl],
    ));
  }
}

function slackJsonResult(response: unknown) {
  return {
    isError: false,
    content: [{
      type: "resource" as const,
      resource: {
        uri: "slack-api-response.json",
        mimeType: "application/json",
        text: JSON.stringify(response),
      },
    }],
  };
}

function slackErrorResult(message: string, err: unknown) {
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: message,
    }, {
      type: "text" as const,
      text: `Error: ${err instanceof Error ? err.message : String(err)}`,
    }],
  };
}
