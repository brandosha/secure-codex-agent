import path from "path";

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { mcpTool, WORKSPACE_PATH } from "./base";
import { execFile, mcpTextResult } from "../utils";



interface GitMcpToolOptions {
  allowForcePush?: boolean; // Whether to allow force pushes
  branches?: {
    allow?: string[];
    block?: string[];
  }
}

const defaultGitMcpToolOptions: GitMcpToolOptions = {
  allowForcePush: false,
};

export function gitMcpTool(options: GitMcpToolOptions = defaultGitMcpToolOptions) {
  return mcpTool("git", createGitMcpServer(options));
}

function createGitMcpServer(options: GitMcpToolOptions) {
  const mcp = new McpServer({
    name: "Git SSH Proxy",
    version: "0.0.1",
  });

  mcp.registerTool("git_ssh_proxy", {
    inputSchema: z.object({
      cwd: z.string(),
      action: z.enum(["ls-remote", "fetch", "push"]),
      remote: z.string(),
      branch: z.string().optional(),
    }),
  }, async (input) => {
    const { cwd, action, remote, branch } = input;

    const repoPath = path.resolve(WORKSPACE_PATH, cwd);
    if (!repoPath.startsWith(WORKSPACE_PATH)) {
      return mcpTextResult("Invalid repository path", true);
    }

    try {
      if (action === "push") {
        assertPushAllowed(options, branch);
      }

      const result = await runGitRemoteCommand({
        action,
        remote,
        branch,
        cwd: repoPath
      });

      return mcpTextResult(`${result.stdout}${result.stderr ? "\n\nstderr:\n" + result.stderr : ""}`);
    } catch (err) {
      return mcpTextResult(`Git command failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  });

  return mcp;
}


const safeGitEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "echo",
  GIT_SSH_COMMAND: `ssh -i ${process.env.SSH_KEY_PATH} -o BatchMode=yes -o StrictHostKeyChecking=no`,
  GIT_PAGER: "cat",
  GIT_EDITOR: "true",
};

// Common defense-in-depth arguments for root git operations
const safeGitArgs = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'credential.helper='
];

interface GitRemoteCommandParams {
  action: "ls-remote" | "fetch" | "push";
  remote: string;
  branch?: string;
  cwd: string;
}
export async function runGitRemoteCommand({ action, remote, branch, cwd }: GitRemoteCommandParams) {
  const args = [action, remote];
  if (branch) {
    args.push(branch);
  }
  return await execFile('git', [
    ...safeGitArgs,
    ...args
  ], {
    cwd,
    env: {
      ...safeGitEnv,
    },
  });
}

export class GitPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitPolicyError";
  }
}


export function assertPushAllowed(options: GitMcpToolOptions, refspec?: string) {
  if (!refspec) {
    throw new GitPolicyError("Push requires an explicit branch or refspec so branch policy can be checked.");
  }

  if (options.allowForcePush === false && refspec.includes("+")) {
    throw new GitPolicyError(`Force pushes are prohibited: refspec ${refspec} contains '+'.`);
  }

  const targetBranch = pushTargetBranch(refspec);
  const branches = options?.branches;
  const allow = branches?.allow?.map(normalizeBranchName);
  const block = branches?.block?.map(normalizeBranchName) ?? [];

  if (allow) {
    if (!allow.includes(targetBranch)) {
      throw new GitPolicyError(
        `Push blocked by allow-list policy. Target branch ${targetBranch} is not in allow list: ${allow.join(", ") || "(empty)"}.`,
      );
    }
    return { targetBranch, mode: "allow" as const };
  }

  if (block.includes(targetBranch)) {
    throw new GitPolicyError(`Push blocked by block-list policy. Target branch ${targetBranch} is blocked.`);
  }

  return { targetBranch, mode: "block" as const };
}

function pushTargetBranch(refspec: string) {
  const target = refspec.split(":", 2)[1] ?? refspec;
  const normalizedTarget = normalizeBranchName(target);
  if (!normalizedTarget) {
    throw new GitPolicyError(`Unable to determine push target branch from refspec ${refspec}.`);
  }

  return normalizedTarget;
}

function normalizeBranchName(branch: string) {
  return branch.replace(/^refs\/heads\//, "");
}
