// Cloudflare Worker for the Claude connector. Its own Worker, apart from the
// website: nothing else is served here, the website's access rule does not
// apply, and it holds no broker key (see mcp.ts).
import { handleMcp, type ConnectorEnv } from "./mcp.js";

export default {
  fetch(request: Request, env: ConnectorEnv): Promise<Response> {
    return handleMcp(request, env);
  },
};
