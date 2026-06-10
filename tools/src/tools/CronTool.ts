import { CronJob } from "cron";

import { Tool } from "./base";

export class CronTool extends Tool {
  constructor(
    cronTime: string,
    prompt: string | ((date: Date) => string)
  ) {
    super((server, agent) => {
      CronJob.from({
        cronTime,
        onTick() {
          if (typeof prompt === "string") {
            agent.prompt(prompt);
          } else {
            const input = prompt(new Date());
            agent.prompt(input);
          }
        },
        start: true,
      })
    });
  }
}

