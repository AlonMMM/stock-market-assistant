import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Dark mode for the whole app (user 2026-10-27) works through the colour
// tokens at the top of styles.css; a colour written straight into a rule
// would stay light in the dark theme.
const css = readFileSync(
  new URL("../apps/web/src/styles.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1]!.trim().replace(/\s+/g, " "),
  body: m[2]!,
}));
const tokens = (selector: string) =>
  new Set(
    [
      ...rules
        .find((r) => r.selector === selector)!
        .body.matchAll(/--([\w-]+):/g),
    ].map((m) => m[1]!),
  );

test("every colour token has a dark value", () => {
  const light = tokens(":root");
  const dark = tokens(":root.dark");
  assert.ok(light.size > 50);
  assert.deepEqual(
    [...light].filter((t) => !dark.has(t)),
    [],
  );
  assert.deepEqual(
    [...dark].filter((t) => !light.has(t)),
    [],
  );
});

test("rules use colour tokens, not colours written in", () => {
  // Allowed: the token blocks, rules written for the dark theme, and the
  // full-screen chart, which is always dark.
  const own =
    /^:root(\.dark)?$|(^|[\s,]):root\.dark\b|(^|[\s,])\.dark\b|fullscreen-chart|(^|[\s,>+~(])\.fs-/;
  const raw = /#[0-9a-fA-F]{3,8}\b|rgba?\((?!var)[^)]*\)|:\s*(white|black)\b/;
  const found = rules
    .filter((r) => !own.test(r.selector))
    .filter((r) => raw.test(r.body.replace(/white-space/g, "")))
    .map((r) => r.selector);
  // A glow that reads the same on both themes.
  assert.deepEqual(found, [".pill-icon.dot"]);
});

test("every token a rule uses is defined", () => {
  const light = tokens(":root");
  const used = new Set(
    [...css.matchAll(/var\(--([\w-]+)\)/g)].map((m) => m[1]!),
  );
  const local = new Set(
    [...css.matchAll(/(?:^|[;{\s])--([\w-]+):/g)].map((m) => m[1]!),
  );
  assert.deepEqual(
    [...used].filter((t) => !light.has(t) && !local.has(t)),
    [],
  );
});
