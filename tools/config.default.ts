import { agentTools } from "./src/tools";
import { GitMcpTool } from "./src/tools/all";

agentTools([
  new GitMcpTool({
    allowForcePush: false,
    branches: {
      block: ["main", "master", "prod", "production"],
    },
  }),
]);

// Testing
import { agent } from "./src/agent";
agent.prompt("What mcp tools are available?");