import { agentTools, ChatFrontendTool, GitMcpTool } from "./src/tools";


agentTools([
  new GitMcpTool({
    allowForcePush: false,
    branches: {
      block: ["main", "master", "prod", "production"],
    },
  }),
  new ChatFrontendTool(),
]);
