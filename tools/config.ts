import {
  agentTools,
  chatFrontendTool,
  gitMcpTool,
  type LoginAuthUser,
  newRelicMcpTool,
  remindersTool,
  scheduleMcpTool,
  slackMcpTool,
  trelloTool,
} from "./src/tools";

const chatLoginUsers = process.env.CHAT_LOGIN_USERS
  ? JSON.parse(process.env.CHAT_LOGIN_USERS) as LoginAuthUser | LoginAuthUser[]
  : undefined;


agentTools([
  gitMcpTool({
    allowForcePush: false,
    branches: {
      block: ["main", "master", "prod", "production", "dev"],
    },
  }),
  chatFrontendTool(chatLoginUsers ? {
    loginAuth: {
      users: chatLoginUsers,
      sessionSecret: process.env.CHAT_LOGIN_SESSION_SECRET,
    },
  } : undefined),
  trelloTool({
    apiKey: process.env.TRELLO_API_KEY!,
    token: process.env.TRELLO_TOKEN!,
    secret: process.env.TRELLO_WEBHOOK_SECRET,
    originHostname: process.env.TRELLO_WEBHOOK_HOSTNAME,
  }),
  slackMcpTool({
    token: process.env.SLACK_BOT_TOKEN!,
  }),
  newRelicMcpTool({
    apiKey: process.env.NEWRELIC_API_KEY!,
  }),
  scheduleMcpTool(),
  remindersTool(),
]);
