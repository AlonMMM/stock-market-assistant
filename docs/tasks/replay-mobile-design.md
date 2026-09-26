# Replay mobile design

Owner: frontend
Status: implemented
Branch: feat/replay-mobile-design

## Outcome

Implement the user-approved mobile mockup as the actual replay homepage. Sage/cream styling, three configuration inputs, primary replay action, historical upload with return-to-demo, alert evidence and proportional comparison bars. Live mode is visibly unavailable. No sample results appear before a successful API response.

## Acceptance and verification

Browser scenarios cover mobile demo evidence and no horizontal overflow, changed settings clearing prior results, empty results, API failure/retry, historical upload provenance, return to demo, and cooldown reaching the engine. Screenshots are captured by browser tests at phone and desktop sizes. Local browser installation times out; CI must execute these scenarios. Manual visual inspection remains outstanding.

## Handoff

Depends on PR #3's replay API. No live data or hosting is added. Model-generated concept image is a reference, not used as a UI asset. Run npm run dev to use the implementation.
