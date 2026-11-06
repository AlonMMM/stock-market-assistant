// The backlog (docs/backlog.md) as data: checks the file's format and prints
// its items as JSON, for the board at claude.ai that mirrors it (AGENTS.md,
// Backlog). `npm run backlog` exits 1 and names the problem when the file
// breaks its format.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const parts = {
  Analysis: "analysis",
  Research: "research",
  App: "app",
  "Data & Infra": "infra",
};
export const statuses = ["open", "active", "waiting", "done"];
const fields = ["id", "status", "tags", "waiting", "log", "source", "done"];
const idPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const doneKept = 10;

/** Items in file order: {id, title, part, rank, status, tags, waiting, log, source, done, notes}. */
export function parseBacklog(text) {
  const items = [];
  const errors = [];
  let part = null;
  let item = null;
  let notes = [];
  const finish = () => {
    if (!item) return;
    // Lines of one paragraph join with spaces; a blank line starts a new one.
    item.notes = notes
      .join("\n")
      .trim()
      .replace(/([^\n])\n(?!\n)/g, "$1 ");
    items.push(item);
    item = null;
    notes = [];
  };
  text.split("\n").forEach((line, i) => {
    const at = `line ${i + 1}`;
    const section = /^## (.+?)\s*$/.exec(line);
    if (section) {
      finish();
      part = parts[section[1]] ?? null;
      return;
    }
    const heading = /^### (.+?)\s*$/.exec(line);
    if (heading) {
      finish();
      if (!part) {
        errors.push(
          `${at}: "${heading[1]}" is not under a part (${Object.keys(parts).join(", ")})`,
        );
        return;
      }
      const rank = items.filter((x) => x.part === part).length + 1;
      item = {
        id: "",
        title: heading[1],
        part,
        rank,
        status: "",
        tags: [],
        waiting: "",
        log: "",
        source: "",
        done: "",
        notes: "",
      };
      return;
    }
    if (!item) return;
    const field = /^- (\w+): (.*)$/.exec(line);
    if (field && notes.length === 0 && fields.includes(field[1])) {
      const value = field[2].trim();
      item[field[1]] =
        field[1] === "tags"
          ? value
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : value;
      return;
    }
    if (line.trim() || notes.length) notes.push(line);
  });
  finish();
  const seen = new Set();
  for (const x of items) {
    const name = `"${x.title}"`;
    if (!idPattern.test(x.id))
      errors.push(`${name}: id must be lowercase words joined by dashes`);
    else if (seen.has(x.id)) errors.push(`${name}: id ${x.id} is used twice`);
    seen.add(x.id);
    if (!statuses.includes(x.status))
      errors.push(`${name}: status must be one of ${statuses.join(", ")}`);
    if (x.status === "waiting" && !x.waiting)
      errors.push(`${name}: a waiting item needs waiting (on what)`);
    if (x.part === "research" && !x.log)
      errors.push(
        `${name}: a Research item needs log (its research log entry)`,
      );
    if (!x.source) errors.push(`${name}: source is missing`);
    if (x.status === "done" && !x.done)
      errors.push(`${name}: a done item needs done (date and PR or session)`);
  }
  for (const [label, key] of Object.entries(parts))
    if (
      items.filter((x) => x.part === key && x.status === "done").length >
      doneKept
    )
      errors.push(
        `${label} keeps its latest ${doneKept} done items; remove the oldest`,
      );
  return { items, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = fileURLToPath(new URL("../docs/backlog.md", import.meta.url));
  const { items, errors } = parseBacklog(readFileSync(file, "utf8"));
  if (errors.length) {
    console.error(`docs/backlog.md:\n- ${errors.join("\n- ")}`);
    process.exit(1);
  }
  console.log(JSON.stringify(items, null, 2));
}
