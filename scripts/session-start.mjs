import { existsSync, readFileSync } from "node:fs";

const sessionPath = ".sma-session.json";
let additionalContext =
  "This is the stock-market-assistant repository. Before substantive work in an interactive conversation, ask the user in Hebrew: באיזה כובע עובדים בסשן הזה — Product + UX, Backend, Frontend או Integration / Review? Ask only once and retain the answer for the conversation. Read-only questions about the repository can be answered without a role. For unattended tasks, infer the narrowest suitable role and state the assumption instead of asking.";

if (existsSync(sessionPath)) {
  try {
    const session = JSON.parse(readFileSync(sessionPath, "utf8"));
    additionalContext =
      session.role && session.task
        ? `A repository session is already configured. Use role ${session.role} for task ${session.task}; do not ask the user to choose a role again.`
        : "The repository session file is invalid. Ask the user which role to use before substantive work.";
  } catch {
    additionalContext =
      "The repository session file is invalid. Ask the user which role to use before substantive work.";
  }
}

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  }),
);
