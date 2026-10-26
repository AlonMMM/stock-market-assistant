// Dark mode for the Watchlist (user 2026-10-26: "Show also dark mode", after
// IBKR's dark watchlist). It follows the phone's setting until the user picks
// one with the button by the title; the pick is kept in this browser only.
import { useEffect, useState } from "react";

export type ThemeChoice = "auto" | "light" | "dark";
const key = "sma.watchlist.theme.v1";
const query = "(prefers-color-scheme: dark)";

const saved = (): ThemeChoice => {
  try {
    const v = localStorage.getItem(key);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
};
const systemDark = () =>
  typeof matchMedia === "function" && matchMedia(query).matches;

/** Whether the Watchlist is dark now, and a setter for the user's pick. */
export function useWatchlistTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(saved);
  const [system, setSystem] = useState(systemDark);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(query);
    const change = () => setSystem(m.matches);
    m.addEventListener("change", change);
    return () => m.removeEventListener("change", change);
  }, []);
  const dark = choice === "dark" || (choice === "auto" && system);
  const choose = (next: ThemeChoice) => {
    setChoice(next);
    try {
      if (next === "auto") localStorage.removeItem(key);
      else localStorage.setItem(key, next);
    } catch {
      // Kept for this visit only.
    }
  };
  return { dark, choice, choose };
}

/** Puts the page in the dark look (`.wl-dark` on <html>) while `on` holds. */
export function useDarkPage(on: boolean) {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("wl-dark", on);
    return () => root.classList.remove("wl-dark");
  }, [on]);
}
