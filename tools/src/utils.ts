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

export function redactSecrets(text: string, secrets: string[]) {
  let redactedText = text;
  for (const secret of secrets) {
    redactedText = redactedText.replaceAll(secret, "[REDACTED]");
  }
  return redactedText;
}
