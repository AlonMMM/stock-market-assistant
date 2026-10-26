import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseBacklog } from "../scripts/backlog.mjs";

test("docs/backlog.md follows its format", () => {
  const { items, errors } = parseBacklog(
    readFileSync(new URL("../docs/backlog.md", import.meta.url), "utf8"),
  );
  assert.deepEqual(errors, []);
  assert.ok(items.length > 0);
  for (const lane of ["now", "next", "later", "done"]) {
    const ranks = items.filter((x) => x.status === lane).map((x) => x.rank);
    assert.deepEqual(
      ranks,
      ranks.map((_, i) => i + 1),
      `${lane} ranks follow the file order`,
    );
  }
});

test("backlog: fields, tags, notes and lane order", () => {
  const { items, errors } = parseBacklog(`# Backlog

## Next

### First thing

- id: first-thing
- area: Bots
- tags: Main bot, Performance
- waiting: A key
- source: A session

One line
of notes.

A second paragraph.

### Second thing

- id: second-thing
- area: App
- source: PR #1
`);
  assert.deepEqual(errors, []);
  assert.deepEqual(items[0], {
    id: "first-thing",
    title: "First thing",
    status: "next",
    rank: 1,
    area: "Bots",
    tags: ["Main bot", "Performance"],
    waiting: "A key",
    source: "A session",
    done: "",
    notes: "One line of notes.\n\nA second paragraph.",
  });
  assert.equal(items[1].rank, 2);
  assert.deepEqual(items[1].tags, []);
});

test("backlog: format mistakes are named", () => {
  const { errors } = parseBacklog(`## Now

### No id

- area: Bots
- source: x

### Bad area

- id: bad-area
- area: Misc
- source: x

## Done

### Finished without a PR

- id: finished
- area: Ops
- source: x

## Someday

### Not under a lane

- id: lost
`);
  assert.deepEqual(errors, [
    'line 24: "Not under a lane" is not under a lane (Now, Next, Later, Done)',
    '"No id": id must be lowercase words joined by dashes',
    '"Bad area": area must be one of Bots, Research, App, Alerts, Ops',
    '"Finished without a PR": a Done item needs done (date and PR)',
  ]);
});
