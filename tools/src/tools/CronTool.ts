import { CronJob } from "cron";

import { agent, Tool } from "../tools";

export class CronTool extends Tool {
  constructor(cronTime: string, prompt: string | ((date: Date) => string)) {
    super();
    
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
  }
}

