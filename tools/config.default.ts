import {
  agentTools,
  chatFrontendTool,
  gitMcpTool,
  mysqlTool,
  newRelicMcpTool,
  remindersTool,
  resourceLockMcpTool,
  scheduleMcpTool,
  slackMcpTool,
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
  // slackMcpTool({
  //   token: process.env.SLACK_BOT_TOKEN!,
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
]);
