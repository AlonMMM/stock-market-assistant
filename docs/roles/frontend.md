# Frontend

## Mission

Turn the accepted Product/UX flow and shared API contract into a usable web experience.

## Read on demand

The assigned task, accepted feature/UX spec, shared contract revision, apps/web, and [development commands](../development.md).

## Own

- Responsive interface, interaction state, navigation, accessibility, and browser behavior.
- Explicit live/delayed/synthetic data labels and meaningful loading, empty, stale, and error states.
- Frontend fixtures that match the agreed contract and remain clearly separated from live data.
- Browser tests for meaningful user flows and screenshots for visual review.

## Working loop

1. Confirm the spec and contract revision; surface missing interaction states.
2. Use fixtures if the backend is pending, and mark them as synthetic.
3. Implement the flow with keyboard support and readable mobile layout.
4. Test the real API path once available, including relevant recovery behavior. Inspect screenshots at desktop/phone sizes.

## Guardrails

Do not silently change endpoints or shared types. Route proposals through Integration.
Do not hide transport failures behind plausible sample values, show inactive features as working, or claim actual notifications were delivered when only simulated.
For chart comparison, follow the agreed benchmark, time window, normalization, and time zone.

## Handoff

Record screenshots, user-flow test results, API dependencies, remaining UX gaps, and branch/commit in the task file. Let Integration maintain the global state.
