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
  for (const part of ["analysis", "research", "app", "infra"]) {
    const ranks = items.filter((x) => x.part === part).map((x) => x.rank);
    assert.deepEqual(
      ranks,
      ranks.map((_, i) => i + 1),
      `${part} ranks follow the file order`,
    );
  }
});

test("backlog: fields, tags, notes and part order", () => {
  const { items, errors } = parseBacklog(`# Backlog

## Research

### First thing

- id: first-thing
- status: waiting
- tags: Main bot, Exits
- waiting: A decision
- log: best-algorithms.md: A test
- source: A session

One line
of notes.

A second paragraph.

## Data & Infra

### Second thing

- id: second-thing
- status: open
- source: The owner
`);
  assert.deepEqual(errors, []);
  assert.deepEqual(items[0], {
    id: "first-thing",
    title: "First thing",
    part: "research",
    rank: 1,
    status: "waiting",
    tags: ["Main bot", "Exits"],
    waiting: "A decision",
    log: "best-algorithms.md: A test",
    source: "A session",
    done: "",
    notes: "One line of notes.\n\nA second paragraph.",
  });
  assert.equal(items[1].part, "infra");
  assert.equal(items[1].rank, 1);
  assert.deepEqual(items[1].tags, []);
});

test("backlog: format mistakes are named", () => {
  const { errors } = parseBacklog(`## App

### No id

- status: open
- source: x

### Bad status

- id: bad-status
- status: later
- source: x

### Waiting on nothing

- id: waiting-nothing
- status: waiting
- source: x

### Finished without a PR

- id: finished
- status: done
- source: x

## Research

### No log

- id: no-log
- status: open
- source: x

## Someday

### Not under a part

- id: lost
`);
  assert.deepEqual(errors, [
    'line 36: "Not under a part" is not under a part (Analysis, Research, App, Data & Infra)',
    '"No id": id must be lowercase words joined by dashes',
    '"Bad status": status must be one of open, active, waiting, done',
    '"Waiting on nothing": a waiting item needs waiting (on what)',
    '"Finished without a PR": a done item needs done (date and PR or session)',
    '"No log": a Research item needs log (its research log entry)',
  ]);
});
