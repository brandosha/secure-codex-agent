import { CronJob } from "cron";

import { Tool } from "./base";

export class CronTool extends Tool {
  constructor(
    name: string,
    cronTime: string,
    prompt: string | ((date: Date) => string)
  ) {
    const from = `cron/${name}`;

    super((server, agent) => {
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
      })
    });
  }
}

