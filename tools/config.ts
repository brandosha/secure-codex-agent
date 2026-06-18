import { agentTools, ChatFrontendTool, GitMcpTool, type LoginAuthUser, NewRelicMcpTool, RemindersTool, ScheduleMcpTool, SlackMcpTool, TrelloMcpTool } from "./src/tools";

const chatLoginUsers = process.env.CHAT_LOGIN_USERS
  ? JSON.parse(process.env.CHAT_LOGIN_USERS) as LoginAuthUser | LoginAuthUser[]
  : undefined;


agentTools([
  new GitMcpTool({
    allowForcePush: false,
    branches: {
      block: ["main", "master", "prod", "production", "dev"],
    },
  }),
  new ChatFrontendTool(chatLoginUsers ? {
    loginAuth: {
      users: chatLoginUsers,
      sessionSecret: process.env.CHAT_LOGIN_SESSION_SECRET,
    },
  } : undefined),
  new TrelloMcpTool({
    apiKey: process.env.TRELLO_API_KEY!,
    token: process.env.TRELLO_TOKEN!,
  }),
  new SlackMcpTool({
    token: process.env.SLACK_BOT_TOKEN!,
  }),
  new NewRelicMcpTool({
    apiKey: process.env.NEWRELIC_API_KEY!,
  }),
  new ScheduleMcpTool(),
  new RemindersTool(),
]);
