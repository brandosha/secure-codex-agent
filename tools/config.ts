import { agentTools, ChatFrontendTool, GitMcpTool, NewRelicMcpTool, RemindersTool, ScheduleMcpTool, SlackMcpTool, TrelloMcpTool } from "./src/tools";


agentTools([
  new GitMcpTool({
    allowForcePush: false,
    branches: {
      block: ["main", "master", "prod", "production", "dev"],
    },
  }),
  new ChatFrontendTool(),
  new TrelloMcpTool(),
  new SlackMcpTool(),
  new NewRelicMcpTool(),
  new ScheduleMcpTool(),
  new RemindersTool(),
]);
