# Private Sites publication

Preserve the approved mobile UI and shared replay engine. Add a Worker fetch adapter and embed the small built frontend assets for a portable self-contained deployment. Local Fastify development continues unchanged. The Worker accepts bounded JSON uploads and returns the same replay evidence as the local API; no uploaded data is persisted. Sites provides owner-private access.

The default build now emits dist/server/index.js and hosting metadata. The Sites source repository stores the exact publication source; GitHub remains the development repository. This publication includes the pending replay and mobile design branches without merging them into main.

Verification: worker/local API parity and invalid/oversized upload tests, existing engine tests, typecheck and build. No live market feed, brokerage access or phone push is enabled.
