import { CronJob } from "cron";

import { simpleTool } from "./base";

export function cronTool(
  name: string,
  cronTime: string,
  prompt: string | ((date: Date) => string)
) {
  const from = `cron/${name}`;

  return simpleTool((agentRouter) => {
    const agent = agentRouter.agent();

    CronJob.from({
      cronTime,
      onTick() {
        if (typeof prompt === "string") {
          agent.prompt(prompt, from);
        } else {
          const input = prompt(new Date());
          agent.prompt(input, from);
        }
      },
      start: true,
    });
  });
}
