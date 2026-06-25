import cp from "child_process";
import { promisify } from "util";

export const execFile = promisify(cp.execFile);

export function mcpTextResult(text: string, isError = false) {
  return {
    isError,
    content: [{
      type: "text" as const,
      text,
    }],
  };
}

export function mcpJsonResult(data: Record<string, unknown>, isError = false) {
  return mcpTextResult(JSON.stringify(data), isError);
}

type Primitive = string | number | boolean | null | undefined | void;
export async function mcpToolResult<T extends Record<string, unknown> | Primitive>(fn: () => T | Promise<T>) {
  try {
    const result =  await fn();
    if (typeof result === "object" && result !== null) {
      return mcpJsonResult(result as Record<string, unknown>);
    } else {
      return mcpTextResult(String(result));
    }
  } catch (error) {
    if (error instanceof Error) {
      return mcpTextResult(error.toString(), true);
    } else if (typeof error === "object") {
      return mcpJsonResult(error as any, true);
    } else {
      return mcpTextResult(String(error), true);
    }
  }
}

export function redactSecrets(text: string, secrets: string[]) {
  let redactedText = text;
  for (const secret of secrets) {
    redactedText = redactedText.replaceAll(secret, "[REDACTED]");
  }
  return redactedText;
}
