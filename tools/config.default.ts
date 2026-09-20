import {
  agentTools,
  chatFrontendTool,
  gitMcpTool,
  mysqlTool,
  newRelicMcpTool,
  remindersTool,
  resourceLockMcpTool,
  scheduleMcpTool,
  slackTool,
  trelloTool,
} from "./src/tools";

agentTools([
  gitMcpTool({
    allowForcePush: false,
    branches: {
      block: ["main", "master", "prod", "production", "dev"],
    },
  }),
  chatFrontendTool(),
  scheduleMcpTool(),
  remindersTool(),
  resourceLockMcpTool(),

  // Copy this file to config.ts and uncomment/configure any tools you need.
  //
  // trelloTool({
  //   apiKey: process.env.TRELLO_API_KEY!,
  //   token: process.env.TRELLO_TOKEN!,
  //   secret: process.env.TRELLO_WEBHOOK_SECRET,
  //   originHostname: process.env.TRELLO_WEBHOOK_HOSTNAME,
  // }),
  //
  // slackTool({
  //   botToken: process.env.SLACK_BOT_TOKEN!,
  //   events: {
  //     appToken: process.env.SLACK_APP_TOKEN!,
  //     allowedUserIds: process.env.SLACK_ALLOWED_USER_IDS,
  //   },
  // }),
  //
  // newRelicMcpTool({
  //   apiKey: process.env.NEWRELIC_API_KEY!,
  // }),
  //
  // mysqlTool("local", {
  //   host: "host.docker.internal",
  //   port: 3306,
  //   user: "root",
  //   password: "",
  //   database: "app",
  // }),
], {
  // Optional defaults for the main agent and all subagents.
  // See https://learn.chatgpt.com/docs/models for current model IDs.
  // model: "gpt-5.6-terra",
  // reasoningEffort: "medium", // minimal, low, medium, high, or xhigh
});
