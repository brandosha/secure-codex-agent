import { agentTools } from "./src/tools";
import { ChatFrontendTool, GitMcpTool } from "./src/tools/all";

agentTools([
  new GitMcpTool({
    allowForcePush: false,
    branches: {
      block: ["main", "master", "prod", "production"],
    },
  }),
  new ChatFrontendTool(),
]);
