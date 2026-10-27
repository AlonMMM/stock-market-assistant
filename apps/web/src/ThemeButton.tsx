import { chooseTheme, useDark } from "./theme.js";

/** The dark mode switch in every page's header. */
export function ThemeButton() {
  const dark = useDark();
  return (
    <button
      type="button"
      className="theme-button"
      aria-pressed={dark}
      title={dark ? "Light mode" : "Dark mode"}
      onClick={() => chooseTheme(dark ? "light" : "dark")}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {dark ? (
          <>
            <circle cx="12" cy="12" r="4.5" />
            <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
          </>
        ) : (
          <path d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1z" />
        )}
      </svg>
      <span className="sr-only">Dark mode</span>
    </button>
  );
}
