import { agentTools, ChatFrontendTool, GitMcpTool, TrelloMcpTool } from "./src/tools";


agentTools([
  new GitMcpTool({
    allowForcePush: false,
    branches: {
      block: ["main", "master", "prod", "production"],
    },
  }),
  new ChatFrontendTool(),
  new TrelloMcpTool(),
]);

