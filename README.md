# Stock Market Assistant

A trading support product, starting with configurable market alerts, chart context,
phone notifications, and historical alert replay.

Current phase: **development harness foundation**. No application or live market connection exists yet.

## Start here
- Agents: read [AGENTS.md](AGENTS.md).
- Product: [scope and open questions](docs/product.md).
- Handoff: [current state](docs/state.md).
- Process: [development workflow](docs/workflow.md).
- Decisions: [decision log](docs/decisions.md).
- New work: copy the [task template](docs/task-template.md) into a task file when a task needs a durable plan.

## Check the foundation

Requires Python 3.9+ and Git, with no third-party dependencies:

```sh
python3 scripts/check_harness.py
git diff --check
```

These commands validate context files and local Markdown links; they do not test a trading application.
Application startup, builds, linting, tests, and browser verification will be added with the first runtime implementation.

## Resume with an AI coding tool

Open this repository as the working directory and ask:

> Read AGENTS.md and docs/state.md, inspect the repository, and summarize the next task before implementing it. Distinguish confirmed requirements from proposals.

Use the same repository with different coding tools. Keep durable context here and avoid simultaneous edits to the same working tree.
