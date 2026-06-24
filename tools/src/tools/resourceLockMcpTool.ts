import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AgentRouter } from "../agent";
import { mcpTextResult } from "../utils";
import { mcpTool } from "./base";

const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const MIN_LEASE_MS = 30 * 1000;
const MAX_LEASE_MS = 60 * 60 * 1000;

const resourceIdSchema = z.string().trim().min(1);
const leaseMsSchema = z.number().int().min(MIN_LEASE_MS).max(MAX_LEASE_MS).optional();

const resourceRequestSchema = z.object({
  resourceId: resourceIdSchema,
  reason: z.string().trim().min(1).optional(),
  leaseMs: leaseMsSchema,
});

const resourceIdInputSchema = z.object({
  resourceId: resourceIdSchema,
});

const renewResourceSchema = z.object({
  resourceId: resourceIdSchema,
  leaseMs: leaseMsSchema,
});

const resourceStatusSchema = z.object({
  resourceId: resourceIdSchema.optional(),
});

type ResourceRequestInput = z.infer<typeof resourceRequestSchema>;

interface QueueEntry {
  resourceId: string;
  agentId: string | undefined;
  requestedAt: string;
  reason?: string;
  leaseMs: number;
}

interface ResourceHolder {
  resourceId: string;
  agentId: string | undefined;
  acquiredAt: string;
  leaseExpiresAt: string;
  reason?: string;
  leaseMs: number;
}

interface ResourceState {
  holder?: ResourceHolder;
  queue: QueueEntry[];
  timer?: NodeJS.Timeout;
}

export function resourceLockMcpTool() {
  return mcpTool("resource_lock", (agentRouter) => createResourceLockMcpServer(agentRouter));
}

function createResourceLockMcpServer(agentRouter: AgentRouter) {
  const resources = new Map<string, ResourceState>();
  const stateMutex = createMutex();

  const mcp = new McpServer({
    name: "Resource Lock MCP Tool",
    version: "0.0.1",
  });

  mcp.registerTool("request_resource", {
    description: "Request exclusive access to a scarce resource. If it is free, access is granted immediately in this response. If it is held, the caller is queued and will be prompted when it becomes their turn.",
    inputSchema: resourceRequestSchema,
  }, async (input, ctx) => {
    const agent = agentRouter.agent(ctx);

    return stateMutex.runExclusive(async () => {
      const state = getResourceState(resources, input.resourceId);
      const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;

      if (!state.holder) {
        const holder = acquireResource(state, input, agent.id, leaseMs);
        scheduleLeaseExpiry(resources, stateMutex, agentRouter, state, holder);

        return jsonResult({
          status: "acquired",
          resourceId: input.resourceId,
          holder: holder.agentId,
          leaseExpiresAt: holder.leaseExpiresAt,
          message: "Resource acquired immediately. No follow-up prompt will be sent for this acquisition.",
        });
      }

      if (state.holder.agentId === agent.id) {
        return jsonResult({
          status: "already_held",
          resourceId: input.resourceId,
          holder: state.holder.agentId,
          leaseExpiresAt: state.holder.leaseExpiresAt,
        });
      }

      const existingQueueIndex = state.queue.findIndex((entry) => entry.agentId === agent.id);
      if (existingQueueIndex !== -1) {
        return jsonResult({
          status: "queued",
          resourceId: input.resourceId,
          queuePosition: existingQueueIndex + 1,
          requestedAt: state.queue[existingQueueIndex].requestedAt,
          message: "The caller is already queued for this resource.",
        });
      }

      const entry: QueueEntry = {
        resourceId: input.resourceId,
        agentId: agent.id,
        requestedAt: new Date().toISOString(),
        reason: input.reason,
        leaseMs,
      };
      state.queue.push(entry);

      return jsonResult({
        status: "queued",
        resourceId: input.resourceId,
        queuePosition: state.queue.length,
        requestedAt: entry.requestedAt,
      });
    });
  });

  mcp.registerTool("release_resource", {
    description: "Release a resource currently held by the caller, then grant it to the next queued agent if one is waiting.",
    inputSchema: resourceIdInputSchema,
  }, async ({ resourceId }, ctx) => {
    const agent = agentRouter.agent(ctx);

    return stateMutex.runExclusive(async () => {
      const state = resources.get(resourceId);
      if (!state?.holder) {
        return jsonResult({
          status: "not_held",
          resourceId,
          message: "This resource is not currently held.",
        }, true);
      }

      if (state.holder.agentId !== agent.id) {
        return jsonResult({
          status: "not_holder",
          resourceId,
          holder: state.holder.agentId,
          message: "Only the current holder can release this resource.",
        }, true);
      }

      clearLeaseTimer(state);
      const nextHolder = grantNextQueuedAgent(resources, stateMutex, agentRouter, resourceId, state);

      return jsonResult({
        status: "released",
        resourceId,
        nextHolder: nextHolder?.agentId,
        nextLeaseExpiresAt: nextHolder?.leaseExpiresAt,
      });
    });
  });

  mcp.registerTool("renew_resource", {
    description: "Extend the caller's current lease for a held resource.",
    inputSchema: renewResourceSchema,
  }, async ({ resourceId, leaseMs }, ctx) => {
    const agent = agentRouter.agent(ctx);

    return stateMutex.runExclusive(async () => {
      const state = resources.get(resourceId);
      if (!state?.holder) {
        return jsonResult({
          status: "not_held",
          resourceId,
          message: "This resource is not currently held.",
        }, true);
      }

      if (state.holder.agentId !== agent.id) {
        return jsonResult({
          status: "not_holder",
          resourceId,
          holder: state.holder.agentId,
          message: "Only the current holder can renew this resource.",
        }, true);
      }

      state.holder.leaseMs = leaseMs ?? DEFAULT_LEASE_MS;
      state.holder.leaseExpiresAt = extendLeaseExpiry(state.holder.leaseExpiresAt, state.holder.leaseMs);
      scheduleLeaseExpiry(resources, stateMutex, agentRouter, state, state.holder);
      const remainingLeaseMs = remainingMsUntil(state.holder.leaseExpiresAt);

      return jsonResult({
        status: "renewed",
        resourceId,
        holder: state.holder.agentId,
        leaseExpiresAt: state.holder.leaseExpiresAt,
        remainingLeaseMs,
        message: `Lease renewed. ${formatDuration(remainingLeaseMs)} remaining.`,
      });
    });
  });

  mcp.registerTool("resource_status", {
    description: "Report current holders, lease expiries, and queued agents for one resource or all active resources.",
    inputSchema: resourceStatusSchema,
  }, async ({ resourceId }) => {
    return stateMutex.runExclusive(async () => {
      const statuses = resourceId
        ? [statusForResource(resourceId, resources.get(resourceId))]
        : Array.from(resources.entries()).map(([id, state]) => statusForResource(id, state));

      return jsonResult(resourceId ? statuses[0] : statuses);
    });
  });

  mcp.registerTool("cancel_resource_request", {
    description: "Cancel the caller's pending queue entry for a resource. This does not release a resource already held by the caller.",
    inputSchema: resourceIdInputSchema,
  }, async ({ resourceId }, ctx) => {
    const agent = agentRouter.agent(ctx);

    return stateMutex.runExclusive(async () => {
      const state = resources.get(resourceId);
      if (!state) {
        return jsonResult({
          status: "not_queued",
          resourceId,
        });
      }

      const queueIndex = state.queue.findIndex((entry) => entry.agentId === agent.id);
      if (queueIndex === -1) {
        return jsonResult({
          status: "not_queued",
          resourceId,
          heldByCaller: state.holder?.agentId === agent.id,
        });
      }

      state.queue.splice(queueIndex, 1);
      deleteResourceIfIdle(resources, resourceId, state);

      return jsonResult({
        status: "cancelled",
        resourceId,
      });
    });
  });

  return mcp;
}

function acquireResource(
  state: ResourceState,
  input: ResourceRequestInput,
  agentIdentity: string | undefined,
  leaseMs: number,
): ResourceHolder {
  const holder: ResourceHolder = {
    resourceId: input.resourceId,
    agentId: agentIdentity,
    acquiredAt: new Date().toISOString(),
    leaseExpiresAt: leaseExpiryFromNow(leaseMs),
    reason: input.reason,
    leaseMs,
  };
  state.holder = holder;
  return holder;
}

function grantNextQueuedAgent(
  resources: Map<string, ResourceState>,
  stateMutex: Mutex,
  agentRouter: AgentRouter,
  resourceId: string,
  state: ResourceState,
) {
  const next = state.queue.shift();
  if (!next) {
    state.holder = undefined;
    deleteResourceIfIdle(resources, resourceId, state);
    return undefined;
  }

  const holder: ResourceHolder = {
    resourceId,
    agentId: next.agentId,
    acquiredAt: new Date().toISOString(),
    leaseExpiresAt: leaseExpiryFromNow(next.leaseMs),
    reason: next.reason,
    leaseMs: next.leaseMs,
  };
  state.holder = holder;
  scheduleLeaseExpiry(resources, stateMutex, agentRouter, state, holder);
  promptAgentForTurn(agentRouter, holder);
  return holder;
}

function scheduleLeaseExpiry(
  resources: Map<string, ResourceState>,
  stateMutex: Mutex,
  agentRouter: AgentRouter,
  state: ResourceState,
  holder: ResourceHolder,
) {
  clearLeaseTimer(state);

  const delayMs = Math.max(0, new Date(holder.leaseExpiresAt).getTime() - Date.now());
  state.timer = setTimeout(() => {
    void stateMutex.runExclusive(async () => {
      const currentState = resources.get(holder.resourceId);
      if (currentState?.holder !== holder) {
        return;
      }

      clearLeaseTimer(currentState);
      grantNextQueuedAgent(resources, stateMutex, agentRouter, holder.resourceId, currentState);
    });
  }, delayMs);
}

function promptAgentForTurn(agentRouter: AgentRouter, holder: ResourceHolder) {
  const agent = agentRouter.agent(holder.agentId);
  agent.prompt(formatTurnPrompt(holder), `resource_lock/${holder.resourceId}`);
}

function formatTurnPrompt(holder: ResourceHolder) {
  return [
    `It is now your turn to use resource "${holder.resourceId}".`,
    "",
    `Your lease expires at ${holder.leaseExpiresAt}.`,
    "",
    "Use the resource now. When you are finished, call release_resource for this resource. If you need more time before the lease expires, call renew_resource.",
  ].join("\n");
}

function statusForResource(resourceId: string, state: ResourceState | undefined) {
  return {
    resourceId,
    holder: state?.holder ? {
      agentId: state.holder.agentId,
      acquiredAt: state.holder.acquiredAt,
      leaseExpiresAt: state.holder.leaseExpiresAt,
      reason: state.holder.reason,
    } : undefined,
    queue: (state?.queue ?? []).map((entry, index) => ({
      agentId: entry.agentId,
      queuePosition: index + 1,
      requestedAt: entry.requestedAt,
      reason: entry.reason,
    })),
  };
}

function getResourceState(resources: Map<string, ResourceState>, resourceId: string) {
  let state = resources.get(resourceId);
  if (!state) {
    state = { queue: [] };
    resources.set(resourceId, state);
  }
  return state;
}

function deleteResourceIfIdle(resources: Map<string, ResourceState>, resourceId: string, state: ResourceState) {
  if (!state.holder && state.queue.length === 0) {
    clearLeaseTimer(state);
    resources.delete(resourceId);
  }
}

function clearLeaseTimer(state: ResourceState) {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
}

function leaseExpiryFromNow(leaseMs: number) {
  return new Date(Date.now() + leaseMs).toISOString();
}

function extendLeaseExpiry(currentLeaseExpiresAt: string, leaseMs: number) {
  const currentExpiry = new Date(currentLeaseExpiresAt).getTime();
  const base = Math.max(currentExpiry, Date.now());
  return new Date(base + leaseMs).toISOString();
}

function remainingMsUntil(timestamp: string) {
  return Math.max(0, new Date(timestamp).getTime() - Date.now());
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.ceil(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);

  return parts.join(" ");
}

function jsonResult(value: unknown, isError = false) {
  return mcpTextResult(JSON.stringify(value), isError);
}

interface Mutex {
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
}

function createMutex(): Mutex {
  let locked = false;
  const waiters: Array<() => void> = [];

  async function acquire() {
    if (!locked) {
      locked = true;
      return;
    }

    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
    locked = true;
  }

  function release() {
    const next = waiters.shift();
    if (next) {
      next();
      return;
    }

    locked = false;
  }

  return {
    async runExclusive<T>(work: () => Promise<T>) {
      await acquire();
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}
