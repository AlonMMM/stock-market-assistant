import { useEffect, useState } from "react";
import {
  newYork,
  newYorkToUtc,
} from "../../../packages/market-data/src/calendar.js";
import type { BotView } from "../../../packages/trading/src/bot-api.js";
import { readJson } from "./api.js";
import {
  addTicker,
  algorithmSteps,
  applyVersion,
  botVersions,
  defaultSettings,
  fromBotView,
  leftBacktest,
  resetToDefaults,
  sameSettings,
  settingsWarnings,
  tickerItems,
  toggleTicker,
  untested,
  versionLabelPattern,
  versionState,
  type BotSettings,
  type NumberKey,
  type Rules,
  type SwitchKey,
  type TickerItem,
} from "./bot-settings-model.js";
import {
  botBrokerChoices,
  botBrokers,
  brokerNames,
  type BotBrokerChoice,
} from "../../../packages/trading/src/bot/settings.js";
import { usePolling } from "./Live.js";
import { israelClock } from "./time.js";

const choiceName = (c: BotBrokerChoice) =>
  c === "both" ? "Both" : brokerNames[c];

// The bot's settings (docs/tasks/frontend-bot-settings.md), for the account
// owner only: the stocks it watches, trade size, losses, holding, the contract
// and the signal. It reads and saves `/api/bot/settings`; while the trading
// service does not serve it, the page shows what `/api/bot` reports and says
// that saving is not connected.

const settingsPath = "/api/bot/settings";
const ignore = () => {};

type Link =
  | { state: "loading" }
  | { state: "connected" }
  | { state: "missing"; why: string };
type SaveRun =
  | { step: "idle" }
  | { step: "saving" }
  | { step: "saved" }
  | { step: "failed"; message: string };

interface SliderSpec {
  key: NumberKey;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
}

const pct = (v: number) => `${v}%`;
const minus = (v: number) => `−${v}%`;
const minusOrOff = (v: number) => (v === 0 ? "off" : minus(v));
const count = (v: number) => String(v);

function nightsText(v: number): string {
  if (v === 0) return "Never";
  return `${v} night${v === 1 ? "" : "s"}`;
}

function nightCapText(v: number): string {
  if (v === 0) return "No cap";
  return `${v}% of the account`;
}

const daysText = (v: number) => `${v} day${v === 1 ? "" : "s"}`;

/** The day exit (15:50 New York) on Israel's clock today. */
function dayExitIsrael(): string {
  return israelClock(newYorkToUtc(newYork(Date.now()).date, 950));
}

interface Group {
  title: string;
  sub: string;
  sliders: SliderSpec[];
  switches: [SwitchKey, string, string][];
}

/** The size steps in words: "2.5% from $300K, 1.5% from $1M"; "" when none. */
function stepsText(steps: BotSettings["sizeSteps"]): string {
  const money = (v: number) => {
    if (v < 1e6) return `$${Math.round(v / 1e3)}K`;
    const whole = v % 1e6 === 0;
    return `$${(v / 1e6).toFixed(whole ? 0 : 1)}M`;
  };
  return steps.map((x) => `${x.pct}% from ${money(x.from)}`).join(", ");
}

function groups(s: BotSettings): Group[] {
  const steps = stepsText(s.sizeSteps);
  let sizeSub = "How much each buy spends";
  if (steps)
    sizeSub = `How much each buy spends; as the account grows (its value as the day starts): ${steps}`;
  return [
    {
      title: "Trade size",
      sub: sizeSub,
      sliders: [
        {
          key: "sizePct",
          label: "Size of one trade",
          help: "Share of the account for each buy, at the ask.",
          min: 0.5,
          max: 5,
          step: 0.5,
          fmt: pct,
        },
        {
          key: "maxBuysPerDay",
          label: "Most bot buys a day",
          help: "After this many, signals are skipped until tomorrow.",
          min: 1,
          max: 10,
          step: 1,
          fmt: count,
        },
        {
          key: "maxOpen",
          label: "Most open positions",
          help: "A new signal waits out while this many are held.",
          min: 1,
          max: 10,
          step: 1,
          fmt: count,
        },
      ],
      switches: [],
    },
    {
      title: "Losses",
      sub: "Where the bot cuts, and when it stops",
      sliders: [
        {
          key: "stopPct",
          label: "Stop on a trade",
          help: "Sell all when the option is down this much and the stock moves against the entry.",
          min: 15,
          max: 70,
          step: 5,
          fmt: minus,
        },
        {
          key: "restStopPct",
          label: "Stop on the rest after the 10-min half",
          help: "Once the 10-minute check sold half, sell the rest at this loss on the entry day (with the stock against). 0 keeps the stop above.",
          min: 0,
          max: 50,
          step: 5,
          fmt: minusOrOff,
        },
        {
          key: "stageHalfS30",
          label: "Staged exit: half out at",
          help: "With the staged exit on: on the entry day, sell half once the stock is this many of its usual 30-minute moves against the price at the signal.",
          min: 0.25,
          max: 2,
          step: 0.25,
          fmt: (v) => `${v} × S30`,
        },
        {
          key: "stageFullS30",
          label: "Staged exit: the rest out at",
          help: "With the staged exit on: sell the rest once the stock is this many of its usual 30-minute moves against the signal price.",
          min: 0.5,
          max: 3,
          step: 0.25,
          fmt: (v) => `${v} × S30`,
        },
        {
          key: "lockArmPct",
          label: "Break-even lock: armed from",
          help: "With the break-even lock on: once the option is up this much on the entry day, the bot sells all if the stock gets back to where the option would be worth what was paid.",
          min: 20,
          max: 200,
          step: 10,
          fmt: (v) => `+${v}%`,
        },
        {
          key: "safetyStopPct",
          label: "Broker safety stop",
          help: "A stop order at the broker, in case the bot is down. Should sit below the stop above.",
          min: 30,
          max: 80,
          step: 5,
          fmt: minus,
        },
        {
          key: "dayLossPct",
          label: "Daily loss limit",
          help: "No new bot buys for the rest of the day once the account is down this much today.",
          min: 1,
          max: 10,
          step: 0.5,
          fmt: minus,
        },
        {
          key: "drawdownPausePct",
          label: "Pause after a drawdown",
          help: "Turn the bot off when its trades are down this much from their best. You turn it back on.",
          min: 5,
          max: 40,
          step: 5,
          fmt: minus,
        },
      ],
      switches: [
        [
          "checks",
          "10- and 20-minute checks",
          "Sell half at +10 minutes and the rest at +20 if the stock is against the entry.",
        ],
        [
          "stockStages",
          "Staged stock exit",
          "On the entry day, sell half when the stock moves against the signal price by the first amount below, the rest at the second (in its usual 30-minute moves).",
        ],
        [
          "breakEvenLock",
          "Break-even lock",
          "On the entry day, once the option is up by the amount below, sell all if the stock gets back to the price where the option would be worth what was paid (worked out from its implied volatility, again each minute it is still that far up).",
        ],
        [
          "lateHold",
          "Hold late winners",
          "An entry at 15:00 or later is not sold on its entry day while it is above its cost, up to the 15:50 decision.",
        ],
        [
          "sellOnWeakness",
          "Strength-gone sale",
          "On the entry day, sell all when the stock's strength vs SPY × beta since the open (the t-stat the entry needed) falls to the level below.",
        ],
        [
          "sellFailedBreak",
          "Failed-break sale",
          "On the entry day, sell all when the stock reaches the next level ahead (yesterday's or the 5-day high or low, the 15-minute or the day's high or low) and falls back without breaking it.",
        ],
      ],
    },
    {
      title: "Profits and holding",
      sub: "What may stay overnight",
      sliders: [
        {
          key: "holdFromPct",
          label: "Hold overnight from",
          help: `At the day exit (${dayExitIsrael()} Israel), keep only winners up this much. The rest are sold.`,
          min: 50,
          max: 300,
          step: 25,
          fmt: (v) => `+${v}%`,
        },
        {
          key: "maxNights",
          label: "Most nights held",
          help: "Carried winners are out by then, and always on expiry day.",
          min: 0,
          max: 3,
          step: 1,
          fmt: nightsText,
        },
        {
          key: "nightCapPct",
          label: "Most held overnight",
          help: `Most of the account that may be held overnight, per contract; above it the bot sells at the day exit (${dayExitIsrael()} Israel). 0 is no cap.`,
          min: 0,
          max: 25,
          step: 1,
          fmt: nightCapText,
        },
      ],
      switches: [],
    },
    {
      title: "Contract",
      sub: "Which option a signal buys",
      sliders: [
        {
          key: "delta",
          label: "Delta",
          help: "The strike with the delta closest to this. Lower is cheaper and further out of the money.",
          min: 0.05,
          max: 0.25,
          step: 0.05,
          fmt: (v) => v.toFixed(2),
        },
        {
          key: "maxDte",
          label: "Expiry up to",
          help: "The nearest expiry from 1 day out up to this many days.",
          min: 1,
          max: 14,
          step: 1,
          fmt: daysText,
        },
        {
          key: "minPrice",
          label: "Cheapest contract",
          help: "Skip contracts under this price (with the cheap fallback on, take a nearer strike instead).",
          min: 0.05,
          max: 1,
          step: 0.05,
          fmt: (v) => `$${v.toFixed(2)}`,
        },
        {
          key: "minVolume",
          label: "Least traded",
          help: "Skip contracts with fewer trades in the last 30 minutes.",
          min: 0,
          max: 1000,
          step: 50,
          fmt: (v) => `${v} contracts`,
        },
      ],
      switches: [
        [
          "cheapFallback",
          "Cheap fallback",
          "When the chosen option costs under the cheapest price, buy the nearest strike toward the money that costs at least that, instead of skipping (version 2.6).",
        ],
      ],
    },
  ];
}

const signalSliders: SliderSpec[] = [
  {
    key: "minT",
    label: "Strength vs SPY (t)",
    help: "How steadily the 1-minute moves must beat SPY × beta.",
    min: 1,
    max: 4,
    step: 0.1,
    fmt: (v) => `t ${v}`,
  },
  {
    key: "d2T",
    label: "D2 bonus: strength (t)",
    help: "With the D2 bonus on, this lower strength also enters when the stock held up on SPY's down minutes.",
    min: 1,
    max: 1.8,
    step: 0.1,
    fmt: (v) => `t ${v}`,
  },
  {
    key: "minD2",
    label: "D2 bonus: held up on SPY's down minutes",
    help: "The stock's move beyond beta × SPY on the minutes of the last 30 that SPY fell (rose, for a put), in typical 30-minute moves.",
    min: 0.5,
    max: 3,
    step: 0.1,
    fmt: (v) => `D2 ${v.toFixed(1)}`,
  },
  {
    key: "minRvol",
    label: "Volume vs normal",
    help: "Volume since the open against the usual by that time.",
    min: 1,
    max: 3,
    step: 0.1,
    fmt: (v) => `${v.toFixed(1)}×`,
  },
  {
    key: "firstEntryMin",
    label: "First entry after the open",
    help: "Minutes after the open before the first signal can buy.",
    min: 5,
    max: 60,
    step: 5,
    fmt: (v) => `${v} min`,
  },
];
const signalSwitches: [SwitchKey, string, string][] = [
  [
    "d2Entry",
    "D2 bonus entry",
    "Also enter at the lower strength below when the stock held up while SPY fell (version 2.5).",
  ],
  [
    "skipEarnings",
    "Skip earnings reaction days",
    "No new entry on the first session after a report.",
  ],
  [
    "skipPremarket",
    "Skip pre-market volume 4× normal",
    "News days fire the volume test without a real move.",
  ],
];

// Range steps such as 0.05 drift in floating point: snap to the step.
const snap = (v: number, step: number) =>
  Number((Math.round(v / step) * step).toFixed(4));

function Slider({
  spec,
  s,
  warn,
  onChange,
}: {
  spec: SliderSpec;
  s: BotSettings;
  warn: boolean;
  onChange: (v: number) => void;
}) {
  const value = s[spec.key];
  const base = defaultSettings[spec.key];
  const changed = value !== base;
  // Values the backtest never ran have a default, not a backtest value.
  let source = "Backtest";
  if (untested.has(spec.key)) source = "Default";
  let hint = `${source}: ${spec.fmt(base)}`;
  if (changed) hint = `Changed · ${source.toLowerCase()} ${spec.fmt(base)}`;
  const id = `bs-${spec.key}`;
  return (
    <div className="bs-row">
      <div className="bs-what">
        <label htmlFor={id}>{spec.label}</label>
        <span className="muted small">{spec.help}</span>
      </div>
      <div className="bs-control">
        <div className="bs-value">
          <b className={warn ? "bs-bad" : ""}>{spec.fmt(value)}</b>
          <span className={changed ? "bs-changed" : "muted"}>{hint}</span>
        </div>
        <input
          id={id}
          type="range"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={value}
          onChange={(e) => onChange(snap(Number(e.target.value), spec.step))}
        />
        <div className="bs-ends" aria-hidden="true">
          <span>{spec.fmt(spec.min)}</span>
          <span>{spec.fmt(spec.max)}</span>
        </div>
      </div>
    </div>
  );
}

function Switch({
  label,
  help,
  on,
  onToggle,
}: {
  label: string;
  help: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="bs-row bs-switch">
      <div className="bs-what">
        <span className="bs-label">{label}</span>
        <span className="muted small">{help}</span>
      </div>
      <button
        type="button"
        className="bs-tog"
        aria-pressed={on}
        aria-label={label}
        onClick={onToggle}
      >
        {on ? "On" : "Off"}
      </button>
    </div>
  );
}

type Show = "all" | "core" | "fav" | "added" | "off";
const shows: [Show, string, (k: TickerItem) => boolean][] = [
  ["all", "All", () => true],
  ["core", "Core", (k) => k.core],
  ["fav", "Favorites", (k) => k.favorite],
  ["added", "Added", (k) => k.added],
  ["off", "Off", (k) => !k.on],
];

/** Where a stock comes from: the mark beside it and its tooltip. */
function origin(k: TickerItem): { mark: string; tone: string; title: string } {
  if (k.added) return { mark: "+", tone: "added", title: "Added by you" };
  if (k.core && k.favorite)
    return { mark: "★", tone: "fav", title: "Core list and your favorites" };
  if (k.favorite)
    return { mark: "★", tone: "fav", title: "Your favorites list" };
  return { mark: "●", tone: "core", title: "Core list" };
}

function Stocks({
  s,
  core,
  favorites,
  onChange,
}: {
  s: BotSettings;
  core: string[];
  favorites: BotView["favorites"];
  onChange: (s: BotSettings) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [show, setShow] = useState<Show>("all");
  const favTickers = favorites?.tickers ?? [];
  const items = tickerItems(s, core, favTickers);
  const watched = items.filter((k) => k.on);
  const coreOn = watched.filter((k) => k.core).length;
  const favNew = watched.filter((k) => k.favorite && !k.core).length;
  const filter = shows.find(([key]) => key === show)![2];
  const add = () => {
    const next = addTicker(s, text, [...core, ...favTickers]);
    if (typeof next === "string") {
      setError(next);
      return;
    }
    onChange(next);
    setText("");
    setError("");
  };
  let favName = "your favorites";
  if (favorites) favName = `"${favorites.name}"`;
  let syncLabel = "Not following Favorites";
  if (s.followFavorites) syncLabel = "Following Favorites";
  return (
    <section className="bot-card bs-card" aria-labelledby="bs-stocks">
      <div className="bs-card-head">
        <div>
          <h2 id="bs-stocks">Stocks to watch · {watched.length}</h2>
          <p className="muted small">
            {coreOn} core · {favNew} more from {favName} · tap a ticker to turn
            it off. Applies from the next session.
          </p>
        </div>
        <div className="bs-add">
          <label htmlFor="bs-add-ticker" className="visually-hidden">
            Add a ticker
          </label>
          <input
            id="bs-add-ticker"
            type="text"
            placeholder="Add ticker"
            autoComplete="off"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <button type="button" className="bs-primary" onClick={add}>
            Add
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="bs-error small">
          {error}
        </p>
      )}
      {!favorites && (
        <p className="bot-warn small">
          The bot has no favorites list yet. Name a watchlist with "fav" in its
          name; the site sends it to the bot.
        </p>
      )}
      <div className="bs-bar">
        <div className="bs-seg" role="group" aria-label="Show">
          {shows.map(([key, label, f]) => (
            <button
              type="button"
              key={key}
              aria-pressed={show === key}
              onClick={() => setShow(key)}
            >
              {label} <span>{items.filter(f).length}</span>
            </button>
          ))}
        </div>
        <div className="bs-legend small">
          <span>
            <i className="core">●</i>core
          </span>
          <span>
            <i className="fav">★</i>Favorites
          </span>
          <span>
            <i className="added">+</i>added by you
          </span>
          <button
            type="button"
            className="bs-tog small"
            aria-pressed={s.followFavorites}
            onClick={() =>
              onChange({ ...s, followFavorites: !s.followFavorites })
            }
          >
            {syncLabel}
          </button>
        </div>
      </div>
      <ul className="bs-tickers" aria-label="Stocks">
        {items.filter(filter).map((k) => {
          const o = origin(k);
          let state = "off";
          if (k.on) state = "on";
          return (
            <li key={k.t}>
              <button
                type="button"
                aria-pressed={k.on}
                title={`${o.title} · ${state}`}
                onClick={() => onChange(toggleTicker(s, k.t))}
              >
                <span>{k.t}</span>
                <i className={o.tone} aria-hidden="true">
                  {o.mark}
                </i>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="muted small">
        QQQ and SQQQ start off: index ETFs, left out of the backtest. Never
        watched: SPY (the benchmark) and the futures CL, GC and SI.
      </p>
    </section>
  );
}

/** One rule set's full algorithm, folded: the owner opens it to read every rule. */
function VersionRules({
  title,
  since,
  rules,
  running,
  onRun,
}: {
  title: string;
  since?: string;
  rules: Rules;
  running: boolean;
  onRun?: () => void;
}) {
  return (
    <details className="bs-rules">
      <summary>
        <span>{title}</span>
        {since && <span className="muted small">since {since}</span>}
        {running && <span className="bot-version">running</span>}
      </summary>
      <ol>
        {algorithmSteps(rules).map((step) => (
          <li key={step.name}>
            <b>{step.name}.</b> {step.text}
          </li>
        ))}
      </ol>
      {onRun && (
        <button type="button" className="bs-secondary" onClick={onRun}>
          Run these rules
        </button>
      )}
    </details>
  );
}

/**
 * The bot's version (packages/trading/src/bot/versions.ts): pick a known rule
 * set, see where the rules below were changed from it, or name an own one.
 * Every entry is stamped with what this card shows as the label. Each version
 * opens to its full algorithm in words.
 */
function VersionCard({
  s,
  onChange,
}: {
  s: BotSettings;
  onChange: (s: BotSettings) => void;
}) {
  const { known, changes, label, latest, bump, next } = versionState(s);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const edited = changes.length > 0;
  const name = () => {
    const next = text.trim();
    if (!versionLabelPattern.test(next)) {
      setError("A label is 1–24 letters, digits, dots, dashes or spaces.");
      return;
    }
    onChange({ ...s, version: next });
    setText("");
    setError("");
  };
  let standing = `Entries are stamped “${label}”.`;
  if (!known)
    standing = `Your own rule set, “${label}”: the rules below as you set them. Entries are stamped “${label}”.`;
  else if (edited)
    standing = `The rules below differ from ${known.id}; entries are stamped “${label}”.`;
  // Which number the change moves: a core setting or a rule on / off is MINOR, a rule's own number PATCH.
  let size = "";
  if (known && bump === "minor")
    size = ` A core change (a core setting, or a rule switched on or off): as a new version it would be ${next}.`;
  else if (known && bump === "patch")
    size = ` A configuration change (a rule's own numbers): as a new version it would be ${next}.`;
  return (
    <section className="bot-card bs-card" aria-labelledby="bs-version">
      <div className="bs-card-head">
        <div>
          <h2 id="bs-version">Bot version · {label}</h2>
          <p className="muted small">
            Which set of trading rules the bot runs. Your limits (size, buys a
            day, losses) and the stocks are not part of a version.
          </p>
        </div>
        {!latest && (
          <span className="small bs-changed">
            Not the newest version ({botVersions.at(-1)!.id})
          </span>
        )}
      </div>
      <div className="bs-seg bs-versions" role="group" aria-label="Version">
        {botVersions.map((v) => (
          <button
            type="button"
            key={v.id}
            aria-pressed={s.version === v.id}
            title={v.name}
            onClick={() => onChange(applyVersion(s, v.id))}
          >
            {v.id}
          </button>
        ))}
      </div>
      {known && (
        <p className="small">
          <b>
            {known.id} · {known.name}
          </b>{" "}
          <span className="muted">since {known.since}.</span> {known.notes}
        </p>
      )}
      <p className={edited || !known ? "small bs-changed" : "muted small"}>
        {standing}
        {size}
      </p>
      <div className="bs-rules-list">
        <p className="muted small">Full rules of each version: tap to open.</p>
        {(edited || !known) && (
          <VersionRules
            title={`${label} · the rules as set below`}
            rules={s}
            running
          />
        )}
        {[...botVersions].reverse().map((v) => {
          const chosen = known?.id === v.id;
          let onRun: (() => void) | undefined = () =>
            onChange(applyVersion(s, v.id));
          if (chosen && !edited) onRun = undefined;
          return (
            <VersionRules
              key={v.id}
              title={`${v.id} · ${v.name}`}
              since={v.since}
              rules={v.rules}
              running={chosen && !edited}
              onRun={onRun}
            />
          );
        })}
      </div>
      {edited && (
        <p className="small">
          Changed: {changes.join("; ")}.{" "}
          <button
            type="button"
            className="bs-link"
            onClick={() => onChange(applyVersion(s, known!.id))}
          >
            Back to {known!.id}&apos;s rules
          </button>
        </p>
      )}
      {(edited || !known) && (
        <div className="bs-add bs-name">
          <label htmlFor="bs-version-label" className="visually-hidden">
            Name this rule set
          </label>
          <input
            id="bs-version-label"
            type="text"
            placeholder={`Name this rule set, e.g. ${next ?? "2.7.1"}`}
            autoComplete="off"
            maxLength={24}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") name();
            }}
          />
          <button type="button" className="bs-secondary" onClick={name}>
            Name it
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="bs-error small">
          {error}
        </p>
      )}
    </section>
  );
}

/** Reads the saved settings; tells whether the trading service serves them. */
function useSavedSettings(): [
  Link,
  BotSettings | null,
  (s: BotSettings) => void,
] {
  const [link, setLink] = useState<Link>({ state: "loading" });
  const [saved, setSaved] = useState<BotSettings | null>(null);
  useEffect(() => {
    let live = true;
    fetch(settingsPath, { signal: AbortSignal.timeout(15000) })
      .then(async (r) => {
        // Not served yet: a 404 or 405, or the page itself instead of JSON.
        const json = (r.headers.get("content-type") ?? "").includes("json");
        if (r.status === 404 || r.status === 405 || !json) {
          if (live)
            setLink({
              state: "missing",
              why: "The trading service does not take settings from the app yet.",
            });
          return;
        }
        const value = await readJson<BotSettings>(r);
        if (!live) return;
        setSaved({ ...defaultSettings, ...value });
        setLink({ state: "connected" });
      })
      .catch((e: unknown) => {
        if (!live) return;
        const message = e instanceof Error ? e.message : "failed";
        setLink({
          state: "missing",
          why: `The saved settings could not be read (${message}).`,
        });
      });
    return () => {
      live = false;
    };
  }, []);
  return [link, saved, setSaved];
}

export function BotSettingsPage({ onBack }: { onBack: () => void }) {
  const { value: view } = usePolling<BotView>("/api/bot", 15000, ignore);
  const [link, saved, setSaved] = useSavedSettings();
  const [draft, setDraft] = useState<BotSettings | null>(null);
  const [run, setRun] = useState<SaveRun>({ step: "idle" });
  const [advanced, setAdvanced] = useState(false);

  // Without saved settings, start from what the bot reports.
  let base = saved;
  if (!base && link.state === "missing" && view) base = fromBotView(view);
  const s = draft ?? base;

  if (link.state === "loading" || !s)
    return <p className="notice">Loading the bot&apos;s settings…</p>;

  const dirty = base !== null && !sameSettings(s, base);
  const put = (patch: Partial<BotSettings>) => {
    setDraft({ ...s, ...patch });
    setRun({ step: "idle" });
  };
  const connected = link.state === "connected";
  const warnings = settingsWarnings(s);

  const save = async () => {
    setRun({ step: "saving" });
    try {
      const next = await readJson<BotSettings>(
        await fetch(settingsPath, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(s),
          signal: AbortSignal.timeout(15000),
        }),
      );
      setSaved({ ...defaultSettings, ...next });
      setDraft(null);
      setRun({ step: "saved" });
    } catch (e) {
      setRun({
        step: "failed",
        message: e instanceof Error ? e.message : "Saving failed",
      });
    }
  };

  let status = "All changes saved.";
  let statusTone = "muted";
  if (!connected) {
    status = "Saving is not connected yet; nothing here reaches the bot.";
    statusTone = "bs-changed";
  } else if (run.step === "saving") {
    status = "Saving…";
  } else if (run.step === "failed") {
    status = `Not saved: ${run.message}`;
    statusTone = "bs-bad";
  } else if (dirty) {
    status =
      "Unsaved changes. Stocks apply from the next session, the rest from the next minute.";
    statusTone = "bs-changed";
  } else if (run.step === "saved") {
    status = "Saved. The bot uses the new settings.";
    statusTone = "bs-good";
  }
  const canSave = connected && dirty && run.step !== "saving";

  let modeHelp = "Every signal is a paper order.";
  if (s.mode === "dry") modeHelp = "Signals are logged as “would buy”.";
  // The brokers the trading service has connected; an older service names none.
  const brokers = view?.brokers ?? botBrokers.filter((b) => b === s.broker);
  const canChoose = (c: BotBrokerChoice) =>
    c === "both" ? brokers.length >= 2 : brokers.includes(c);
  let brokerHelp =
    "New entries are bought there; an open position is sold where it was bought.";
  if (s.broker === "both")
    brokerHelp =
      "Every signal is bought at both accounts, the same contract, to compare fills and fees. A position is sold where it was bought.";
  else if (brokers.length < 2)
    brokerHelp = `Only ${choiceName(brokers[0] ?? s.broker)} is connected.`;

  return (
    <div className="bot-panel bot-settings">
      <div className="bs-head">
        <div className="bs-title">
          <button type="button" className="bs-back" onClick={onBack}>
            ← Back to the Bot
          </button>
          <h2 className="portfolio-title">Bot settings</h2>
          <p className="muted small">
            <span className="bs-owner">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="4" y="11" width="16" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
              Only you see this page
            </span>{" "}
            Everyone else sees the Bot tab, read-only.
          </p>
        </div>
        <div className="bs-switches">
          <button
            type="button"
            className="bs-tog bs-power"
            aria-pressed={s.enabled}
            onClick={() => put({ enabled: !s.enabled })}
          >
            <span className={s.enabled ? "dot on" : "dot"} aria-hidden="true" />
            {s.enabled ? "Bot on" : "Bot off"}
          </button>
          <div className="bs-seg" role="group" aria-label="Mode">
            <button
              type="button"
              aria-pressed={s.mode === "live"}
              onClick={() => put({ mode: "live" })}
            >
              Trade the paper account
            </button>
            <button
              type="button"
              aria-pressed={s.mode === "dry"}
              onClick={() => put({ mode: "dry" })}
            >
              Dry run, no orders
            </button>
          </div>
          <span className="muted small">{modeHelp}</span>
          <div className="bs-seg" role="group" aria-label="Broker">
            {botBrokerChoices.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={s.broker === c}
                disabled={!canChoose(c)}
                title={canChoose(c) ? undefined : "Not connected"}
                onClick={() => put({ broker: c })}
              >
                {choiceName(c)}
              </button>
            ))}
          </div>
          <span className="muted small">{brokerHelp}</span>
        </div>
      </div>

      {link.state === "missing" && (
        <p className="bot-warn small" role="status">
          {link.why} The values shown are what the bot reports (on/off, mode,
          size, delta, stocks watched today) and the defaults for the rest. You
          can try changes here, but Save stays off until the settings API is
          live.
        </p>
      )}

      <VersionCard s={s} onChange={(next) => put(next)} />

      {view ? (
        <Stocks
          s={s}
          core={view.universe}
          favorites={view.favorites}
          onChange={(next) => put(next)}
        />
      ) : (
        <p className="notice">The bot&apos;s stock lists are not available.</p>
      )}

      {groups(s).map((g) => (
        <section key={g.title} className="bot-card bs-card">
          <div className="bs-card-head">
            <h2>{g.title}</h2>
            <span className="muted small">{g.sub}</span>
          </div>
          {g.sliders.map((spec) => (
            <Slider
              key={spec.key}
              spec={spec}
              s={s}
              warn={
                (spec.key === "sizePct" && s.sizePct > 3) ||
                (spec.key === "safetyStopPct" && s.safetyStopPct < s.stopPct)
              }
              onChange={(v) => put({ [spec.key]: v })}
            />
          ))}
          {g.switches.map(([key, label, help]) => (
            <Switch
              key={key}
              label={label}
              help={help}
              on={s[key]}
              onToggle={() => put({ [key]: !s[key] })}
            />
          ))}
        </section>
      ))}

      <section className="bot-card bs-card bs-advanced">
        <button
          type="button"
          className="bs-expand"
          aria-expanded={advanced}
          onClick={() => setAdvanced(!advanced)}
        >
          <span>
            <b>Signal (advanced)</b>
            <span className="muted small">
              The entry rule itself. Changing it leaves the backtested rules.
            </span>
          </span>
          <span aria-hidden="true">{advanced ? "▴" : "▾"}</span>
        </button>
        {advanced && (
          <div>
            <p className={leftBacktest(s) ? "bot-warn small" : "muted small"}>
              The backtest numbers are for strength t 1.8, volume 1.5×, the
              first entry 10 minutes in and both news filters on. Other values
              are untested.
            </p>
            {signalSliders.map((spec) => (
              <Slider
                key={spec.key}
                spec={spec}
                s={s}
                warn={false}
                onChange={(v) => put({ [spec.key]: v })}
              />
            ))}
            {signalSwitches.map(([key, label, help]) => (
              <Switch
                key={key}
                label={label}
                help={help}
                on={s[key]}
                onToggle={() => put({ [key]: !s[key] })}
              />
            ))}
          </div>
        )}
      </section>

      <div className="bs-foot small">
        <span className="muted">
          Your own risk rules still apply to every bot buy: 10 buys a day, open
          risk 10%, one position 5%, quotes under 2 minutes old.
        </span>
        <button
          type="button"
          className="bs-link"
          onClick={() => put(resetToDefaults(s))}
        >
          Reset everything to the defaults
        </button>
      </div>

      <div className="bs-savebar">
        <div>
          <span role="status" className={`small ${statusTone}`}>
            {status}
          </span>
          {warnings.map((w) => (
            <span key={w} className="small bs-bad">
              {w}
            </span>
          ))}
        </div>
        <div className="bs-actions">
          <button
            type="button"
            className="bs-secondary"
            disabled={!dirty}
            onClick={() => {
              setDraft(null);
              setRun({ step: "idle" });
            }}
          >
            Discard
          </button>
          <button
            type="button"
            className="bs-primary"
            disabled={!canSave}
            onClick={() => void save()}
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
