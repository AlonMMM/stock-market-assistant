// Dark mode for the whole app (user 2026-10-27: "Add dark mode for all the
// app"; the Watchlist had it first, 2026-10-26, after IBKR's dark watchlist).
// It follows the phone's setting until the user picks one with the button in
// the header; the pick is kept in this browser only. `.dark` on <html> turns
// the colour tokens in styles.css dark; index.html sets it before the first
// paint so a dark page does not flash white.
import { useSyncExternalStore } from "react";

export type ThemeChoice = "auto" | "light" | "dark";
const key = "sma.theme.v1";
// The Watchlist's own pick, from before the whole app had a theme.
const watchlistKey = "sma.watchlist.theme.v1";
const query = "(prefers-color-scheme: dark)";

const saved = (): ThemeChoice => {
  try {
    const v = localStorage.getItem(key) ?? localStorage.getItem(watchlistKey);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
};
const media = () =>
  typeof matchMedia === "function" ? matchMedia(query) : null;

let choice: ThemeChoice = saved();
let system = media()?.matches ?? false;
const listeners = new Set<() => void>();
const isDark = () => choice === "dark" || (choice === "auto" && system);

function apply() {
  if (typeof document !== "undefined")
    document.documentElement.classList.toggle("dark", isDark());
  for (const l of listeners) l();
}
media()?.addEventListener("change", (e) => {
  system = e.matches;
  apply();
});
apply();

export function chooseTheme(next: ThemeChoice) {
  choice = next;
  try {
    localStorage.removeItem(watchlistKey);
    if (next === "auto") localStorage.removeItem(key);
    else localStorage.setItem(key, next);
  } catch {
    // Kept for this visit only.
  }
  apply();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Whether the app is dark now, read when a canvas chart draws. */
export const isDarkNow = isDark;

/** Whether the app is dark now; charts drawn on a canvas pick colours by it. */
export function useDark() {
  return useSyncExternalStore(subscribe, isDark, () => false);
}
