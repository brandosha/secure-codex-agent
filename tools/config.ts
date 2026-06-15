import { agentTools, ChatFrontendTool, GitMcpTool, NewRelicMcpTool, RemindersTool, ScheduleMcpTool, SlackMcpTool, TrelloMcpTool } from "./src/tools";


agentTools([
  new GitMcpTool({
    allowForcePush: false,
    branches: {
      block: ["main", "master", "prod", "production", "dev"],
    },
  }),
  new ChatFrontendTool(),
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
