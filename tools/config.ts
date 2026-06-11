import { agentTools, ChatFrontendTool, GitMcpTool, NewRelicMcpTool, ScheduleMcpTool, TrelloMcpTool } from "./src/tools";


agentTools([
  new GitMcpTool({
    allowForcePush: false,
    branches: {
      block: ["main", "master", "prod", "production", "dev"],
    },
  }),
  new ChatFrontendTool(),
  new TrelloMcpTool(),
  new NewRelicMcpTool(),
  new ScheduleMcpTool(),
]);
