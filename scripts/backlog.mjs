// The backlog (docs/backlog.md) as data: checks the file's format and prints
// its items as JSON, for the board at claude.ai that mirrors it (AGENTS.md,
// Backlog). `npm run backlog` exits 1 and names the problem when the file
// breaks its format.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const lanes = { Now: "now", Next: "next", Later: "later", Done: "done" };
export const areas = ["Bots", "Research", "App", "Alerts", "Ops"];
const fields = ["id", "area", "tags", "waiting", "source", "done"];
const idPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Items in file order: {id, title, status, rank, area, tags, waiting, source, done, notes}. */
export function parseBacklog(text) {
  const items = [];
  const errors = [];
  let status = null;
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
    const lane = /^## (.+?)\s*$/.exec(line);
    if (lane) {
      finish();
      status = lanes[lane[1]] ?? null;
      return;
    }
    const heading = /^### (.+?)\s*$/.exec(line);
    if (heading) {
      finish();
      if (!status) {
        errors.push(
          `${at}: "${heading[1]}" is not under a lane (Now, Next, Later, Done)`,
        );
        return;
      }
      const rank = items.filter((x) => x.status === status).length + 1;
      item = {
        id: "",
        title: heading[1],
        status,
        rank,
        area: "",
        tags: [],
        waiting: "",
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
    if (!areas.includes(x.area))
      errors.push(`${name}: area must be one of ${areas.join(", ")}`);
    if (!x.source) errors.push(`${name}: source is missing`);
    if (x.status === "done" && !x.done)
      errors.push(`${name}: a Done item needs done (date and PR)`);
  }
  if (items.filter((x) => x.status === "done").length > 10)
    errors.push("Done keeps the latest 10 items; remove the oldest");
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
