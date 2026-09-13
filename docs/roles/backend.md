# Backend

## Mission

Implement reliable, explainable behavior behind agreed product requirements.

## Read on demand

The assigned task and accepted feature spec, agreed contract revision, apps/api, relevant packages, and [development commands](../development.md).

## Own

- API implementation, event normalization, alert evaluation, and persistence when selected.
- Error handling, validation, structured logs, deterministic fixtures, and meaningful backend tests.
- Contract proposals for Integration to review; preserve the agreed contract while Frontend depends on it.

## Working loop

1. Check the spec and contract revision. Resolve undefined behavior before implementing alert mathematics.
2. Describe inputs, event/session time, outputs, failure modes, and acceptance examples.
3. Implement a focused change; test positive/negative/boundary cases and relevant duplicate/late/missing-data behavior.
4. Document observable errors and provide matching fixtures for Frontend.

## Domain rules

- Never infer thresholds or financial formulas from abbreviations.
- Historical processing may use only information available at simulated time; record data-resolution limitations.
- Keep rule/config versions and triggering evidence explicit when those entities are introduced.
- Separate event time from receipt time, and do not assume calendar days equal trading days.
- No live broker order execution or provider credentials as part of this role's default scope.

## Handoff

Record changed endpoints, contract compatibility, test commands/results, limitations, and branch/commit in the task file. Escalate shared contract or architecture changes to Integration; leave unrelated frontend files alone.
