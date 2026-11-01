import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  coreClose,
  newYork,
  previousSessions,
} from "../../../packages/market-data/src/calendar.js";
import type { Watchlist } from "../../../packages/market-data/src/watchlists.js";
import {
  defaultMoney,
  runAccount,
  type AccountTrade,
  type MoneySettings,
} from "../../../packages/trading/src/bot/backtest-account.js";
import { defaultFillPct } from "../../../packages/trading/src/bot/backtest.js";
import {
  limits,
  type NumberKey,
} from "../../../packages/trading/src/bot/settings.js";
import {
  botVersions,
  currentVersion,
  ruleChanges,
  sameRules,
  versionById,
  type RuleKey,
  type Rules,
} from "../../../packages/trading/src/bot/versions.js";
import coreList from "../../../config/bot-universe.json";
import volumeList from "../../../config/volume-bot-stocks.json";
import { readJson } from "./api.js";
import type { BotView } from "../../../packages/trading/src/bot-api.js";
import {
  defaultSettings,
  type BotSettings,
} from "../../../packages/trading/src/bot/settings.js";
import {
  backtestStory,
  bots,
  clockText,
  closedTradeOf,
  exitTitle,
  firstDate,
  maxStocks,
  paperSetup,
  parseTickers,
  periodRange,
  periods,
  ruleGroups,
  runClock,
  sessionsBetween,
  signalRows,
  signalsCsv,
  skipCounts,
  spreadPct,
  type SignalRow,
  statusWords,
  stepMs,
  type BotId,
  type PeriodId,
} from "./bot-backtest-model.js";
import {
  startRun,
  stopRun,
  useBacktestRun,
  volumeRun,
  type Busy,
  type Ran,
  type RanBase,
} from "./bot-backtest-run.js";
import {
  defaultStrangleSettings,
  strangleStocks,
  strangleWithDefaults,
  type StrangleSettings,
} from "../../../packages/trading/src/strangle/settings.js";
import { volumeAccount } from "../../../packages/trading/src/strangle/backtest.js";
import {
  VolumeEmpty,
  VolumeRules,
  VolumeSignalList,
  VolumeSummary,
  VolumeTradeList,
} from "./VolumeBacktest.js";
import {
  closedVolumeTrade,
  defaultVolumeMoney,
  sameRun,
  volumeMoney,
  volumeRows,
  type VolumeMoneySetup,
} from "./volume-backtest-model.js";
import { Card, NumberRow } from "./backtest-ui.js";
import { signedPct, signedUsd, tone, usd } from "./format.js";
import {
  israelClock,
  israelDateTime,
  israelDayLabel,
  israelLabel,
} from "./time.js";

// The Backtest section (the user, 2026-10-30): which bot, which version, the
// stocks and the period; change the settings and run. The result is the
// total gain or loss and every trade, each opening the History window's chart
// with its entry and exits.

const PnlChart = lazy(() =>
  import("./PnlChart.js").then((m) => ({ default: m.PnlChart })),
);
const TradeStory = lazy(() =>
  import("./TradeStory.js").then((m) => ({ default: m.TradeStory })),
);

const setupKey = "sma.botBacktest.setup.v1";

interface Setup {
  bot: BotId;
  version: string;
  rules: Rules;
  tickers: string[];
  period: PeriodId | "custom";
  from: string;
  to: string;
  money: Omit<MoneySettings, "nightCapPct" | "fillPct">;
  fillPct: number;
  // The Volume bot's: its settings (from the live bot's, then changed here),
  // the live ones they started from, and the account's money.
  volume: {
    settings: StrangleSettings;
    base: StrangleSettings | null;
    money: VolumeMoneySetup;
  };
}

/** The last session whose data is final now (the server's rule). */
function lastSession(now: number): string {
  const ny = newYork(now);
  const close = coreClose(ny.date);
  if (close !== null && ny.minute >= close) return ny.date;
  return previousSessions(ny.date, 1)[0]!;
}

function defaultSetup(last: string): Setup {
  const { from, to } = periodRange(3, last);
  const { nightCapPct: _cap, fillPct: _fill, ...money } = defaultMoney;
  return {
    bot: "main",
    version: currentVersion,
    rules: versionById(currentVersion)!.rules,
    tickers: coreList.symbols.slice(0, 10),
    period: "3m",
    from,
    to,
    money,
    fillPct: defaultFillPct,
    volume: {
      settings: defaultStrangleSettings,
      base: null,
      money: defaultVolumeMoney,
    },
  };
}

function savedSetup(last: string): Setup {
  const base = defaultSetup(last);
  try {
    const raw = localStorage.getItem(setupKey);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<Setup>;
    const setup = {
      ...base,
      ...saved,
      rules: { ...base.rules, ...saved.rules },
      money: { ...base.money, ...saved.money },
      volume: {
        settings: strangleWithDefaults({ ...saved.volume?.settings }),
        base: saved.volume?.base
          ? strangleWithDefaults(saved.volume.base)
          : null,
        money: { ...base.volume.money, ...saved.volume?.money },
      },
    };
    // A preset period moves with the calendar.
    const preset = periods.find((p) => p.id === setup.period);
    if (preset) return { ...setup, ...periodRange(preset.months, last) };
    return setup;
  } catch {
    return base;
  }
}

/** The version label a run is stamped with: starred when its rules were changed. */
function versionLabel(version: string, rules: Rules): string {
  const known = versionById(version);
  if (!known) return version;
  if (sameRules(known.rules, rules)) return known.id;
  return `${known.id}*`;
}

export function BotBacktest({ modes }: { modes: ReactNode }) {
  const last = useMemo(() => lastSession(Date.now()), []);
  const [setup, setSetupState] = useState<Setup>(() => savedSetup(last));
  const setSetup = (next: Setup) => {
    setSetupState(next);
    try {
      localStorage.setItem(setupKey, JSON.stringify(next));
    } catch {
      // Remembered for this visit only.
    }
  };
  const patch = (p: Partial<Setup>) => setSetup({ ...setup, ...p });
  const [typed, setTyped] = useState("");
  const [lists, setLists] = useState<Watchlist[]>([]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [paper, setPaper] = useState<
    | { state: "idle" }
    | { state: "loading" }
    | { state: "loaded"; text: string }
    | { state: "failed"; text: string }
  >({ state: "idle" });

  async function loadPaper() {
    setPaper({ state: "loading" });
    try {
      const [settings, view] = await Promise.all([
        fetch("/api/bot/settings", {
          signal: AbortSignal.timeout(15000),
        }).then((r) => readJson<BotSettings>(r)),
        fetch("/api/bot", { signal: AbortSignal.timeout(15000) }).then((r) =>
          readJson<BotView>(r),
        ),
      ]);
      const live = paperSetup(
        { ...defaultSettings, ...settings },
        view.watching,
      );
      setSetup({
        ...setup,
        bot: "main",
        version: live.version,
        rules: live.rules,
        tickers: live.tickers,
        money: { ...setup.money, ...live.money },
      });
      setPaper({
        state: "loaded",
        text: `Loaded the paper bot as it is now: ${versionLabel(live.version, live.rules)}, ${live.money.sizePct}% a trade, ${live.money.maxBuysPerDay} buys a day, ${live.money.maxOpen} open, ${live.tickers.length} stocks.`,
      });
    } catch (e) {
      setPaper({
        state: "failed",
        text: `The paper bot's settings could not be read (${e instanceof Error ? e.message : "failed"}).`,
      });
    }
  }
  // The Volume bot's settings start from the live bot's (the user,
  // 2026-10-31): read once, and again with "Same as paper".
  async function loadVolumePaper(next: Setup = setup) {
    setPaper({ state: "loading" });
    try {
      const [saved, body] = await Promise.all([
        fetch("/api/strangle/settings", {
          signal: AbortSignal.timeout(15000),
        }).then((r) => readJson<StrangleSettings>(r)),
        fetch("/api/watchlists").then((r) =>
          readJson<{ lists: Watchlist[] }>(r),
        ),
      ]);
      const live = strangleWithDefaults(saved);
      const favorites =
        body.lists.find((l) => /favou?rite/i.test(l.name))?.tickers ?? [];
      const tickers = strangleStocks(live, favorites).slice(0, maxStocks);
      setSetup({
        ...next,
        bot: "volume",
        ...(tickers.length ? { tickers } : {}),
        volume: { ...next.volume, settings: live, base: live },
      });
      setPaper({
        state: "loaded",
        text: `Loaded the Volume bot as it is now: delta ${live.delta}, ${live.sizePct}% a trade, ${live.shockAlert ? "plan + shock alerts" : "plan alerts"}, ${tickers.length} stocks.`,
      });
    } catch (e) {
      setSetup({
        ...next,
        bot: "volume",
        tickers: volumeList.symbols.slice(0, maxStocks),
      });
      setPaper({
        state: "failed",
        text: `The Volume bot's settings could not be read (${e instanceof Error ? e.message : "failed"}); its defaults are used.`,
      });
    }
  }
  function pickBot(bot: BotId) {
    const next = { ...setup, bot };
    setPaper({ state: "idle" });
    if (bot === "volume" && !setup.volume.base) void loadVolumePaper(next);
    else setSetup(next);
  }
  const isVolume = setup.bot === "volume";

  // The runs live outside the page: they go on, and stay, across sections.
  const main = useBacktestRun();
  const vol = volumeRun.use();
  const { runs, ran } = main;
  const { busy, errors, stopped } = isVolume ? vol : main;
  const [filter, setFilter] = useState<"all" | "won" | "lost" | "refused">(
    "all",
  );
  const [open, setOpen] = useState<AccountTrade | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/watchlists")
      .then((r) => readJson<{ lists: Watchlist[] }>(r))
      .then((body) => {
        if (active)
          setLists(body.lists.filter((l) => !l.builtIn && l.tickers.length));
      })
      .catch(() => {
        // The quick picks are a convenience; tickers can be typed.
      });
    return () => {
      active = false;
    };
  }, []);

  const sessions = sessionsBetween(setup.from, setup.to).length;
  const changes = versionById(setup.version)
    ? ruleChanges(setup.rules, versionById(setup.version)!)
    : [];
  const runnable = setup.tickers.length > 0 && sessions > 0 && !busy;

  function run() {
    setOpen(null);
    if (isVolume) {
      void volumeRun.start({
        settings: setup.volume.settings,
        fillPct: setup.fillPct,
        tickers: setup.tickers,
        from: setup.from,
        to: setup.to,
      });
      return;
    }
    void startRun({
      version: versionLabel(setup.version, setup.rules),
      rules: setup.rules,
      fillPct: setup.fillPct,
      tickers: setup.tickers,
      from: setup.from,
      to: setup.to,
    });
  }

  const trades = useMemo(() => runs.flatMap((r) => r.trades), [runs]);
  const skips = useMemo(() => runs.flatMap((r) => r.skips), [runs]);
  const account = useMemo(
    () =>
      ran
        ? runAccount(trades, {
            ...setup.money,
            nightCapPct: ran.rules.nightCapPct,
            fillPct: ran.fillPct,
          })
        : null,
    [trades, setup.money, ran],
  );
  const signals = useMemo(
    () => signalRows(runs, account?.trades ?? []),
    [runs, account],
  );
  const shown = (account?.trades ?? [])
    .filter((a) => {
      if (filter === "won") return a.status === "taken" && a.pnl > 0;
      if (filter === "lost") return a.status === "taken" && a.pnl <= 0;
      if (filter === "refused") return a.status !== "taken";
      return true;
    })
    .sort(
      (a, b) =>
        stepMs(b.trade.date, b.trade.minute) -
        stepMs(a.trade.date, a.trade.minute),
    );
  // The Volume bot's result: the account applies the money and the size and
  // limits settings at once; the rest needs a new run.
  const vMoney = volumeMoney(setup.volume.money, setup.volume.settings);
  const vAccount = useMemo(
    () => (vol.ran ? volumeAccount(vol.runs, vMoney) : null),
    // The money is rebuilt each render: its values, not the object, decide.
    [vol.runs, vol.ran, JSON.stringify(vMoney)],
  );
  const vRows = useMemo(
    () => volumeRows(vol.runs, vAccount),
    [vol.runs, vAccount],
  );
  const vIgnored = [...new Set(vol.runs.flatMap((r) => r.ignored))];
  const vStale =
    vol.ran !== null &&
    (!sameRun(vol.ran.settings, setup.volume.settings) ||
      vol.ran.fillPct !== setup.fillPct ||
      vol.ran.from !== setup.from ||
      vol.ran.to !== setup.to ||
      vol.ran.tickers.join() !== setup.tickers.join());
  const volumeChanges = setup.volume.base
    ? (Object.keys(setup.volume.base) as (keyof StrangleSettings)[]).filter(
        (k) =>
          JSON.stringify(setup.volume.base![k]) !==
          JSON.stringify(setup.volume.settings[k]),
      ).length
    : 0;

  const stale =
    ran !== null &&
    (!sameRules(ran.rules, setup.rules) ||
      ran.fillPct !== setup.fillPct ||
      ran.from !== setup.from ||
      ran.to !== setup.to ||
      ran.tickers.join() !== setup.tickers.join());

  const addTickers = (more: string[]) =>
    patch({
      tickers: [...new Set([...setup.tickers, ...more])].slice(0, maxStocks),
    });
  // Typed tickers are checked against Alpaca's stock list first; a made-up
  // one is named and not added (the quick picks are known lists).
  const [checking, setChecking] = useState(false);
  const [unknown, setUnknown] = useState<string[]>([]);
  const addTyped = async () => {
    const wanted = parseTickers(typed);
    if (!wanted.length || checking) return;
    setChecking(true);
    const known = await checkTickers(wanted);
    setChecking(false);
    setUnknown(wanted.filter((t) => !known.includes(t)));
    addTickers(known);
    setTyped("");
  };

  return (
    <div className="backtest-page bot-bt">
      <header>
        <div className="brand-status">
          <span className="brand">
            SMA<span className="brand-dot">.</span>
          </span>
        </div>
        {modes}
      </header>

      {busy && !isVolume && ran && (
        <RunLoader busy={busy} ran={ran} onStop={stopRun} />
      )}
      {busy && isVolume && vol.ran && (
        <RunLoader busy={busy} ran={vol.ran} onStop={volumeRun.stop} />
      )}

      <div className="backtest-layout">
        <form
          className="setup"
          aria-label="Backtest setup"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (runnable) run();
          }}
        >
          <div className="setup-intro">
            <h1>Backtest</h1>
            <p>
              Runs a bot&apos;s rules over past sessions on the stocks you pick.
              Fills on real quotes where there are any, else on Alpaca minute
              bars.
            </p>
          </div>
          <fieldset className="setup-cards" disabled={busy !== null}>
            <legend className="sr-only">Setup</legend>

            <Card title="Bot">
              <label>
                Bot
                <select
                  value={setup.bot}
                  onChange={(e) => pickBot(e.target.value as BotId)}
                >
                  {bots.map((b) => (
                    <option key={b.id} value={b.id} disabled={!b.ready}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              {!isVolume && (
                <>
                  <label>
                    Version
                    <select
                      value={setup.version}
                      onChange={(e) =>
                        patch({
                          version: e.target.value,
                          rules: versionById(e.target.value)!.rules,
                        })
                      }
                    >
                      {[...botVersions].reverse().map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.id} · {v.name}
                          {v.id === currentVersion ? " (live)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="muted small">
                    {versionById(setup.version)?.notes}
                  </p>
                </>
              )}
              {isVolume && (
                <p className="muted small">
                  The live Volume bot&apos;s settings, changed below under
                  Rules: plan and shock alerts, the side, the leg and the
                  give-back.
                </p>
              )}
              <button
                type="button"
                className="bt-paper"
                disabled={paper.state === "loading"}
                onClick={() =>
                  void (isVolume ? loadVolumePaper() : loadPaper())
                }
              >
                {paper.state === "loading" ? "Reading paper…" : "Same as paper"}
              </button>
              {paper.state === "loaded" && (
                <p className="muted small">{paper.text}</p>
              )}
              {paper.state === "failed" && (
                <p className="run-error small">{paper.text}</p>
              )}
            </Card>

            <Card
              title="Stocks"
              aside={
                <span className="muted small">
                  {setup.tickers.length} · max {maxStocks}
                </span>
              }
            >
              <div className="bt-chips">
                {setup.tickers.map((t) => (
                  <span key={t} className="chip removable">
                    {t}
                    <button
                      type="button"
                      aria-label={`Remove ${t}`}
                      onClick={() =>
                        patch({ tickers: setup.tickers.filter((x) => x !== t) })
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
                {setup.tickers.length === 0 && (
                  <span className="muted small">No stocks yet.</span>
                )}
              </div>
              <div className="bt-add">
                <input
                  type="text"
                  value={typed}
                  placeholder="Add tickers: NVDA, AMD…"
                  aria-label="Add tickers"
                  autoCapitalize="characters"
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    void addTyped();
                  }}
                />
                <button
                  type="button"
                  className="reset"
                  disabled={!parseTickers(typed).length || checking}
                  onClick={() => void addTyped()}
                >
                  {checking ? "Checking…" : "Add"}
                </button>
              </div>
              {unknown.length > 0 && (
                <p className="stale" role="status">
                  Not added, no such US stock: {unknown.join(", ")}
                </p>
              )}
              <div
                className="preset-chips"
                role="group"
                aria-label="Quick picks"
              >
                <button
                  type="button"
                  className="chip"
                  onClick={() =>
                    patch({ tickers: coreList.symbols.slice(0, maxStocks) })
                  }
                >
                  Bot&apos;s core list ({coreList.symbols.length})
                </button>
                {isVolume && (
                  <button
                    type="button"
                    className="chip"
                    onClick={() =>
                      patch({ tickers: volumeList.symbols.slice(0, maxStocks) })
                    }
                  >
                    Volume bot top 50 ({volumeList.symbols.length})
                  </button>
                )}
                {lists.map((l) => (
                  <button
                    type="button"
                    key={l.id}
                    className="chip"
                    onClick={() =>
                      patch({
                        tickers: parseTickers(l.tickers.join(" ")).slice(
                          0,
                          maxStocks,
                        ),
                      })
                    }
                  >
                    {l.name} ({l.tickers.length})
                  </button>
                ))}
                {setup.tickers.length > 0 && (
                  <button
                    type="button"
                    className="chip"
                    onClick={() => patch({ tickers: [] })}
                  >
                    Clear
                  </button>
                )}
              </div>
            </Card>

            <Card
              title="Period"
              aside={<span className="muted small">{sessions} sessions</span>}
            >
              <div
                className="preset-chips"
                role="group"
                aria-label="Period presets"
              >
                {periods.map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    className="chip"
                    aria-pressed={setup.period === p.id}
                    onClick={() =>
                      patch({ period: p.id, ...periodRange(p.months, last) })
                    }
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="date-row">
                <label>
                  From
                  <input
                    type="date"
                    value={setup.from}
                    min={firstDate}
                    max={setup.to}
                    onChange={(e) =>
                      patch({ period: "custom", from: e.target.value })
                    }
                  />
                </label>
                <label>
                  To
                  <input
                    type="date"
                    value={setup.to}
                    min={setup.from}
                    max={last}
                    onChange={(e) =>
                      patch({ period: "custom", to: e.target.value })
                    }
                  />
                </label>
              </div>
              <p className="muted small">
                Option data starts on {firstDate}; the last full session is{" "}
                {last}.
              </p>
            </Card>

            {!isVolume && (
              <>
                <Card
                  title="Rules"
                  aside={
                    <span
                      className={
                        changes.length ? "rule-badge changed" : "rule-badge"
                      }
                    >
                      {changes.length
                        ? `${changes.length} changed`
                        : `as ${setup.version}`}
                    </span>
                  }
                >
                  <button
                    type="button"
                    className="disclosure"
                    aria-expanded={rulesOpen}
                    aria-controls="bt-rules"
                    onClick={() => setRulesOpen(!rulesOpen)}
                  >
                    Change the rules
                    <span aria-hidden="true">{rulesOpen ? "▴" : "▾"}</span>
                  </button>
                  <div
                    id="bt-rules"
                    className="rule-fields"
                    hidden={!rulesOpen}
                  >
                    {ruleGroups.map((g) => (
                      <fieldset key={g.title} className="rule-group">
                        <legend>{g.title}</legend>
                        {g.fields.map((f) => (
                          <RuleInput
                            key={f.key}
                            field={f}
                            rules={setup.rules}
                            base={versionById(setup.version)?.rules}
                            onChange={(rules) => patch({ rules })}
                          />
                        ))}
                      </fieldset>
                    ))}
                    <button
                      type="button"
                      className="reset"
                      disabled={!changes.length}
                      onClick={() =>
                        patch({ rules: versionById(setup.version)!.rules })
                      }
                    >
                      Back to {setup.version}
                    </button>
                  </div>
                </Card>

                <Card title="Money">
                  <NumberRow
                    label="Start"
                    unit="$"
                    value={setup.money.startEquity}
                    min={1000}
                    max={10_000_000}
                    step={1000}
                    onChange={(v) =>
                      patch({ money: { ...setup.money, startEquity: v } })
                    }
                  />
                  <NumberRow
                    label="Size of one trade"
                    unit="% of the account"
                    value={setup.money.sizePct}
                    min={0.5}
                    max={10}
                    step={0.5}
                    onChange={(v) =>
                      patch({ money: { ...setup.money, sizePct: v } })
                    }
                  />
                  <label className="rule-field switch-row">
                    <span>Compound (size from each day&apos;s account)</span>
                    <input
                      type="checkbox"
                      checked={setup.money.compound}
                      onChange={(e) =>
                        patch({
                          money: { ...setup.money, compound: e.target.checked },
                        })
                      }
                    />
                  </label>
                  <NumberRow
                    label="Fee per contract, each way"
                    unit="$"
                    value={setup.money.feePerContract}
                    min={0}
                    max={5}
                    step={0.01}
                    onChange={(v) =>
                      patch({ money: { ...setup.money, feePerContract: v } })
                    }
                  />
                  <NumberRow
                    label="Most buys a day"
                    value={setup.money.maxBuysPerDay}
                    min={1}
                    max={100}
                    step={1}
                    onChange={(v) =>
                      patch({ money: { ...setup.money, maxBuysPerDay: v } })
                    }
                  />
                  <NumberRow
                    label="Most open positions"
                    value={setup.money.maxOpen}
                    min={1}
                    max={100}
                    step={1}
                    onChange={(v) =>
                      patch({ money: { ...setup.money, maxOpen: v } })
                    }
                  />
                  <NumberRow
                    label="Fill cost (needs a new run)"
                    unit="% of the price"
                    value={setup.fillPct}
                    min={0}
                    max={10}
                    step={0.5}
                    onChange={(v) => patch({ fillPct: v })}
                  />
                  <p className="muted small">
                    Money settings apply to the result at once; the fill cost
                    changes the run.
                  </p>
                </Card>
              </>
            )}
            {isVolume && (
              <>
                <Card
                  title="Rules"
                  aside={
                    <span
                      className={
                        volumeChanges ? "rule-badge changed" : "rule-badge"
                      }
                    >
                      {volumeChanges ? `${volumeChanges} changed` : "as live"}
                    </span>
                  }
                >
                  <button
                    type="button"
                    className="disclosure"
                    aria-expanded={rulesOpen}
                    aria-controls="bt-rules"
                    onClick={() => setRulesOpen(!rulesOpen)}
                  >
                    Change the rules
                    <span aria-hidden="true">{rulesOpen ? "▴" : "▾"}</span>
                  </button>
                  <div
                    id="bt-rules"
                    className="rule-fields"
                    hidden={!rulesOpen}
                  >
                    <VolumeRules
                      settings={setup.volume.settings}
                      base={setup.volume.base}
                      onChange={(settings) =>
                        patch({ volume: { ...setup.volume, settings } })
                      }
                    />
                    <button
                      type="button"
                      className="reset"
                      disabled={!volumeChanges}
                      onClick={() =>
                        patch({
                          volume: {
                            ...setup.volume,
                            settings:
                              setup.volume.base ?? defaultStrangleSettings,
                          },
                        })
                      }
                    >
                      Back to the live settings
                    </button>
                  </div>
                </Card>

                <Card title="Money">
                  <NumberRow
                    label="Start"
                    unit="$"
                    value={setup.volume.money.start}
                    min={1000}
                    max={10_000_000}
                    step={1000}
                    onChange={(v) =>
                      patch({
                        volume: {
                          ...setup.volume,
                          money: { ...setup.volume.money, start: v },
                        },
                      })
                    }
                  />
                  <NumberRow
                    label="Fee per contract, each way"
                    unit="$"
                    value={setup.volume.money.feePerContract}
                    min={0}
                    max={5}
                    step={0.01}
                    onChange={(v) =>
                      patch({
                        volume: {
                          ...setup.volume,
                          money: { ...setup.volume.money, feePerContract: v },
                        },
                      })
                    }
                  />
                  <label className="rule-field switch-row">
                    <span>
                      The live bot&apos;s day limits
                      <span className="hint">
                        {" "}
                        trades a day, open trades, the day&apos;s loss (under
                        Rules)
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={setup.volume.money.limits}
                      onChange={(e) =>
                        patch({
                          volume: {
                            ...setup.volume,
                            money: {
                              ...setup.volume.money,
                              limits: e.target.checked,
                            },
                          },
                        })
                      }
                    />
                  </label>
                  <NumberRow
                    label="Fill cost (needs a new run)"
                    unit="% of the price"
                    value={setup.fillPct}
                    min={0}
                    max={10}
                    step={0.5}
                    onChange={(v) => patch({ fillPct: v })}
                  />
                  <p className="muted small">
                    The size and the limits are under Rules; they apply to the
                    result at once, like the money. The fill cost only prices
                    trades with no real book.
                  </p>
                </Card>
              </>
            )}
          </fieldset>

          <div className="run-block">
            <button type="submit" className="run" disabled={!runnable}>
              {busy ? "Running…" : "Run backtest"}
            </button>
          </div>
        </form>

        <div className="results-column">
          {errors.length > 0 && (
            <div className="run-error">
              <strong>
                {errors.length} part{errors.length === 1 ? "" : "s"} failed
              </strong>
              <ul>
                {errors.slice(0, 5).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          {!isVolume && (
            <>
              {!ran && <Empty />}
              {ran && account && (
                <>
                  {stale && !busy && (
                    <p className="stale">
                      The setup changed since this run. Run again to see it.
                    </p>
                  )}
                  {stopped && !busy && (
                    <p className="stale">
                      Stopped after {stopped.done} of {stopped.total} parts: the
                      result covers those parts only.
                    </p>
                  )}
                  <Summary
                    ran={ran}
                    account={account}
                    money={setup.money}
                    skipsCount={skips.length}
                    busy={busy !== null}
                  />
                  {account.trades.length > 0 && (
                    <Suspense fallback={null}>
                      <PnlChart
                        history={{
                          trades: account.trades
                            .filter((a) => a.status === "taken")
                            .map(closedTradeOf),
                          baseEquity: account.start,
                        }}
                      />
                    </Suspense>
                  )}
                  <SignalList
                    rows={signals}
                    skipsCount={skips.length}
                    onOpen={setOpen}
                  />
                  <TradeList
                    trades={shown}
                    filter={filter}
                    onFilter={setFilter}
                    rules={ran.rules}
                    onOpen={setOpen}
                    total={account.trades.length}
                  />
                </>
              )}
            </>
          )}
          {isVolume && (
            <>
              {!vol.ran && <VolumeEmpty />}
              {vol.ran && vAccount && (
                <>
                  {vStale && !busy && (
                    <p className="stale">
                      The setup changed since this run. Run again to see it.
                    </p>
                  )}
                  {stopped && !busy && (
                    <p className="stale">
                      Stopped after {stopped.done} of {stopped.total} parts: the
                      result covers those parts only.
                    </p>
                  )}
                  <VolumeSummary
                    ran={vol.ran}
                    account={vAccount}
                    money={vMoney}
                    rows={vRows}
                    ignored={vIgnored}
                    busy={busy !== null}
                  />
                  {vAccount.taken > 0 && (
                    <Suspense fallback={null}>
                      <PnlChart
                        history={{
                          trades: vAccount.trades
                            .filter((a) => a.status === "taken")
                            .map(closedVolumeTrade),
                          baseEquity: vAccount.start,
                        }}
                      />
                    </Suspense>
                  )}
                  <VolumeSignalList rows={vRows} />
                  <VolumeTradeList account={vAccount} />
                </>
              )}
            </>
          )}
        </div>
      </div>
      {open && ran && (
        <Suspense fallback={null}>
          <TradeStory
            t={closedTradeOf(open)}
            bot
            backtest={backtestStory(open, ran.rules, ran.version)}
            onClose={() => setOpen(null)}
          />
        </Suspense>
      )}
    </div>
  );
}

/** The run's loader, at the top: the moment in the period it has about reached. */
function RunLoader({
  busy,
  ran,
  onStop,
}: {
  busy: Busy;
  ran: RanBase;
  onStop: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, []);
  const sessions = useMemo(
    () => sessionsBetween(ran.from, ran.to),
    [ran.from, ran.to],
  );
  // The furthest point shown in this run, so the clock never goes back.
  const reached = useRef({ startedAt: busy.startedAt, fraction: 0 });
  if (reached.current.startedAt !== busy.startedAt)
    reached.current = { startedAt: busy.startedAt, fraction: 0 };
  const clock = runClock(
    busy,
    sessions,
    now,
    undefined,
    reached.current.fraction,
  );
  reached.current.fraction = clock.fraction;
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  let left = "estimating…";
  if (clock.leftMs !== null) left = `about ${clockText(clock.leftMs)} left`;
  return (
    <section
      className="bt-loader"
      role="progressbar"
      aria-label="Backtest running"
      aria-valuenow={busy.done}
      aria-valuemax={busy.total}
    >
      <div className="bt-loader-face">
        <span className="bt-loader-label">Replaying</span>
        <span className="bt-loader-day">{israelDayLabel(clock.at)}</span>
        <span className="bt-loader-time num">{israelClock(clock.at)}</span>
      </div>
      <div className="bt-loader-track">
        <span className="bt-loader-end muted small num">{ran.from}</span>
        <div className="bt-loader-rail">
          <span
            className="bt-loader-est"
            style={{ width: pct(clock.fraction) }}
          />
          <span className="bt-loader-done" style={{ width: pct(clock.done) }} />
          <span
            className="bt-loader-head"
            style={{ left: pct(clock.fraction) }}
          />
        </div>
        <span className="bt-loader-end muted small num">{ran.to}</span>
      </div>
      <p className="bt-loader-meta muted small num">
        {busy.done} of {busy.total} parts · {ran.tickers.length} stocks ·{" "}
        {clockText(now - busy.startedAt)} · {left}
        {" · "}
        <button type="button" className="reset" onClick={onStop}>
          Stop
        </button>
      </p>
    </section>
  );
}

function RuleInput({
  field,
  rules,
  base,
  onChange,
}: {
  field: (typeof ruleGroups)[number]["fields"][number];
  rules: Rules;
  base: Rules | undefined;
  onChange: (r: Rules) => void;
}) {
  const key: RuleKey = field.key;
  const value = rules[key];
  const changed = base !== undefined && String(base[key]) !== String(value);
  if (typeof value === "boolean")
    return (
      <label
        className={
          changed ? "rule-field switch-row changed" : "rule-field switch-row"
        }
      >
        <span>
          {field.label}
          {field.help && <span className="hint"> {field.help}</span>}
        </span>
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange({ ...rules, [key]: e.target.checked })}
        />
      </label>
    );
  if (Array.isArray(value))
    return (
      <label className={changed ? "rule-field changed" : "rule-field"}>
        <span>{field.label}</span>
        <input
          type="text"
          defaultValue={value.join(", ")}
          onBlur={(e) =>
            onChange({ ...rules, [key]: parseTickers(e.target.value) })
          }
        />
      </label>
    );
  const [min, max, step] = limits[key as NumberKey];
  return (
    <NumberRow
      label={field.label}
      unit={field.unit}
      value={value}
      min={min}
      max={max}
      step={step}
      changed={changed}
      onChange={(v) => onChange({ ...rules, [key]: v })}
    />
  );
}

function Empty() {
  return (
    <section className="card bt-empty">
      <h2>Test a bot on the past</h2>
      <p className="muted">
        Pick the bot and its version, the stocks and the period, then Run. You
        get the total gain or loss, the account over time, and every trade. Open
        a trade to see its chart with the entry and each exit.
      </p>
      <p className="muted small">
        How it is simulated: the live bot&apos;s own rules, checked every minute
        on the stock&apos;s clock. Prices are real bids and asks when the
        contract has them (Databento&apos;s, uploaded from the research Mac;
        never the live bot&apos;s own books): a buy pays the middle plus a
        quarter of the spread, or the ask when the price ran away; a sale gets
        the bid. A contract without them is priced from its trades (marked
        &quot;Trade prices&quot;): a buy on its next minute bar at the middle
        plus the fill cost, a sale at the middle less it. Early entry is read at
        the minute&apos;s close. The daily loss limit and the drawdown pause are
        not applied.
      </p>
    </section>
  );
}

function Summary({
  ran,
  account,
  money,
  skipsCount,
  busy,
}: {
  ran: Ran;
  account: ReturnType<typeof runAccount>;
  money: Setup["money"];
  skipsCount: number;
  busy: boolean;
}) {
  const refused = account.trades.filter((a) => a.status !== "taken").length;
  const tradePriced = account.trades.filter(
    (a) => a.status === "taken" && a.trade.priced !== "quotes",
  ).length;
  return (
    <section className="card bt-summary" aria-label="Result">
      <div className="bt-total">
        <span className="muted small">
          Main bot {ran.version} · {ran.tickers.length} stocks · {ran.from} →{" "}
          {ran.to}
          {busy ? " · running…" : ""}
        </span>
        <strong className={`bt-pnl num${tone(account.pnl)}`}>
          {signedUsd(account.pnl)}
        </strong>
        <span className={`num${tone(account.pnl)}`}>
          {signedPct(account.returnPct)} · {usd(account.start)} →{" "}
          {usd(account.end)}
        </span>
      </div>
      <dl className="bt-stats num">
        <div>
          <dt>Trades</dt>
          <dd>{account.taken}</dd>
        </div>
        <div>
          <dt>Won</dt>
          <dd>
            {account.wins} ({account.winRate.toFixed(0)}%)
          </dd>
        </div>
        <div>
          <dt>Average win</dt>
          <dd className="up">
            {account.wins ? signedUsd(account.avgWin) : "—"}
          </dd>
        </div>
        <div>
          <dt>Average loss</dt>
          <dd className="down">
            {account.losses ? signedUsd(account.avgLoss) : "—"}
          </dd>
        </div>
        <div>
          <dt>Worst drop</dt>
          <dd>{account.maxDrawdownPct.toFixed(1)}%</dd>
        </div>
        <div>
          <dt>Profit factor</dt>
          <dd>
            {account.profitFactor === null
              ? "—"
              : account.profitFactor.toFixed(2)}
          </dd>
        </div>
      </dl>
      <p className="muted small">
        {money.sizePct}% a trade{money.compound ? ", compounding" : ""} · fees $
        {money.feePerContract.toFixed(2)} a contract each way · fill cost{" "}
        {ran.fillPct}% · overnight cap {ran.rules.nightCapPct}%
        {refused > 0
          ? ` · ${refused} signal${refused === 1 ? "" : "s"} refused by the limits`
          : ""}
        {skipsCount > 0 ? ` · ${skipsCount} skipped by the filters` : ""}
        {account.open > 0
          ? ` · ${account.open} still held, valued at the last price`
          : ""}
        {tradePriced > 0
          ? ` · ${tradePriced} priced from trades (no real quotes), with the fill cost`
          : ""}
        . Simulated, not a promise.
      </p>
    </section>
  );
}

/** The typed tickers that are real US stocks; when the check fails, all of them. */
async function checkTickers(symbols: string[]): Promise<string[]> {
  try {
    const r = await fetch(
      `/api/tickers/check?symbols=${encodeURIComponent(symbols.join(","))}`,
    );
    if (!r.ok) return symbols;
    const body = (await r.json()) as { known?: string[] };
    return symbols.filter((s) => body.known?.includes(s));
  } catch {
    return symbols;
  }
}

/** Every signal of the run in one folded table: bought or not, what the bot saw, what came of it. */
function SignalList({
  rows,
  skipsCount,
  onOpen,
}: {
  rows: SignalRow[];
  skipsCount: number;
  onOpen: (a: AccountTrade) => void;
}) {
  const [which, setWhich] = useState<"all" | "bought" | "skipped">("all");
  const [reason, setReason] = useState<string>("");
  if (!rows.length) return null;
  const reasons = skipCounts(
    rows.flatMap((r) => (r.reason === "bought" ? [] : [{ reason: r.reason }])),
  );
  const shown = rows.filter((r) => {
    if (which === "bought" && !r.bought) return false;
    if (which === "skipped" && r.bought) return false;
    if (reason && r.reason !== reason) return false;
    return true;
  });
  const modelled = rows.filter((r) => r.model);
  const modelWon = modelled.filter((r) => (r.ret ?? 0) > 0).length;
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([signalsCsv(shown)], { type: "text/csv" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "backtest-signals.csv";
    a.click();
    URL.revokeObjectURL(url);
  };
  const filters = [
    ["all", "All"],
    ["bought", "Bought"],
    ["skipped", "Not bought"],
  ] as const;
  return (
    <details className="card bt-signals">
      <summary>
        {rows.length} signal{rows.length === 1 ? "" : "s"} ·{" "}
        {rows.length - skipsCount} bought · {skipsCount} not bought
        {modelled.length > 0 &&
          ` · if bought: ${modelWon} of ${modelled.length} would have gained`}
      </summary>
      <div className="bt-signals-tools">
        <div
          className="segmented small"
          role="group"
          aria-label="Which signals"
        >
          {filters.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={which === id}
              onClick={() => setWhich(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          aria-label="Why not bought"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        >
          <option value="">Every reason</option>
          {reasons.map((r) => (
            <option key={r.reason} value={r.reason}>
              {r.label} ({r.count})
            </option>
          ))}
        </select>
        <button type="button" className="link" onClick={download}>
          Download CSV
        </button>
      </div>
      <div className="bt-signals-scroll">
        <table className="bt-signals-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Stock</th>
              <th>Outcome</th>
              <th title="The option's return on what was paid. Not bought: the trade it would have made on Black-Scholes prices">
                Return
              </th>
              <th title="How long it was held: sold the same day, or the nights held over (the what-if too)">
                Held
              </th>
              <th title="The backtest's buy price. Not bought: the what-if's buy (a model)">
                Bought at
              </th>
              <th title="The real bid / ask as the signal minute closed, and the spread as a share of its middle (Databento; — without one)">
                Bid / ask
              </th>
              <th title="Contracts of this option traded in the 30 minutes before the signal (the bot's liquidity check)">
                Vol 30 min
              </th>
              <th title="Strength against SPY (t-stat)">t</th>
              <th title="The stock's day volume against normal">Vol ×</th>
              <th>D2</th>
              <th>Contract</th>
              <th title="The option's last trade price at the signal, as the bot's pick read it">
                Price
              </th>
              <th>Δ</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <SignalLine key={r.key} r={r} onOpen={onOpen} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Times in {israelLabel}. Not bought: the return is a model, the
        bot&apos;s own exits on Black-Scholes prices from the stock&apos;s
        minutes, at the volatility of the option&apos;s price at the signal (or
        the stock&apos;s 20-day volatility when it had none). A{" "}
        <span className="state-chip">Model</span> contract was not in the chain:
        the target delta at the first expiry in range.
      </p>
    </details>
  );
}

/** "Same day", "1 night", "2 nights"; a dash when unknown. */
function heldWords(nights: number | null): string {
  if (nights === null) return "—";
  if (nights === 0) return "Same day";
  return `${nights} night${nights === 1 ? "" : "s"}`;
}

function SignalLine({
  r,
  onOpen,
}: {
  r: SignalRow;
  onOpen: (a: AccountTrade) => void;
}) {
  const fixed = (v: number | null, digits: number, unit = "") =>
    v === null ? "—" : `${v.toFixed(digits)}${unit}`;
  const money = (v: number | null) => (v === null ? "—" : `$${v.toFixed(2)}`);
  const taken = r.trade?.status === "taken";
  let contract = "—";
  if (r.strike !== null && r.expiry !== null)
    contract = `${r.strike} ${r.right} ${r.expiry.slice(5)}`;
  let ret = "—";
  if (r.ret !== null) ret = signedPct(r.ret * 100);
  let book = "—";
  const spread = spreadPct(r);
  if (r.bid !== null && r.ask !== null && spread !== null)
    book = `${money(r.bid)} / ${money(r.ask)} · ${(spread * 100).toFixed(0)}%`;
  return (
    <tr className={r.bought ? "bought" : ""}>
      <td className="num">{israelDateTime(stepMs(r.date, r.minute))}</td>
      <td>
        {taken && r.trade ? (
          <button
            type="button"
            className="link"
            onClick={() => onOpen(r.trade!)}
          >
            <strong>{r.symbol}</strong>
          </button>
        ) : (
          <strong>{r.symbol}</strong>
        )}{" "}
        {r.right === "C" ? "Call" : "Put"}
        {r.bonus && <span className="state-chip">D2</span>}
        {r.pyramid && <span className="state-chip">Pyramid</span>}
      </td>
      <td title={r.detail || undefined}>{r.outcome}</td>
      <td className={`num${tone(r.ret)}`}>
        {ret}
        {r.model && <span className="small muted"> model</span>}
      </td>
      <td>{heldWords(r.nights)}</td>
      <td className="num">
        {money(r.boughtAt)}
        {r.model && r.boughtAt !== null && (
          <span className="small muted"> model</span>
        )}
      </td>
      <td className="num">{book}</td>
      <td className={`num${r.reason === "illiquid" ? " thin" : ""}`}>
        {r.volume30 ?? "—"}
      </td>
      <td className="num">{fixed(r.t, 1)}</td>
      <td className="num">{fixed(r.rvol, 1, "×")}</td>
      <td className="num">{fixed(r.d2, 1)}</td>
      <td className="num">
        {contract}
        {r.modelled && <span className="state-chip">Model</span>}
      </td>
      <td className="num">{money(r.price)}</td>
      <td className="num">{fixed(r.delta, 2)}</td>
    </tr>
  );
}

function TradeList({
  trades,
  filter,
  onFilter,
  rules,
  onOpen,
  total,
}: {
  trades: AccountTrade[];
  filter: "all" | "won" | "lost" | "refused";
  onFilter: (f: "all" | "won" | "lost" | "refused") => void;
  rules: Rules;
  onOpen: (a: AccountTrade) => void;
  total: number;
}) {
  const filters = [
    ["all", "All"],
    ["won", "Won"],
    ["lost", "Lost"],
    ["refused", "Over the limits"],
  ] as const;
  return (
    <section className="card bt-trades" aria-label="Trades">
      <div className="card-head">
        <h2>Trades</h2>
        <div className="segmented small" role="group" aria-label="Which trades">
          {filters.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => onFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {total === 0 && (
        <p className="muted">No signal was bought in this period.</p>
      )}
      {total > 0 && trades.length === 0 && filter !== "refused" && (
        <p className="muted">None of these.</p>
      )}
      {total > 0 && trades.length === 0 && filter === "refused" && (
        <p className="muted">
          No buy was stopped by the account limits (a day&apos;s buys, open
          positions, a size too small). Signals the bot&apos;s filters skipped
          are in the signals list above.
        </p>
      )}
      <ul className="bt-list">
        {trades.map((a) => (
          <li key={a.trade.id}>
            <button
              type="button"
              className="bt-row"
              disabled={a.status !== "taken"}
              onClick={() => onOpen(a)}
            >
              <span className="bt-when num">
                {israelDateTime(stepMs(a.trade.date, a.trade.minute))}
              </span>
              <span className="bt-what">
                <strong>{a.trade.symbol}</strong> {a.trade.strike}{" "}
                {a.trade.right === "C" ? "Call" : "Put"}
                {a.trade.bonus && <span className="state-chip">D2</span>}
                {a.trade.pyramid && <span className="state-chip">Pyramid</span>}
                {a.open && <span className="state-chip">Open</span>}
                {a.trade.priced !== "quotes" && (
                  <span
                    className="state-chip"
                    title="No real quotes for this contract: priced from its trades"
                  >
                    Trade prices
                  </span>
                )}
              </span>
              {a.status === "taken" ? (
                <>
                  <span className="bt-exit muted">
                    {a.qty} × {(a.paid / a.qty / 100).toFixed(2)} ·{" "}
                    {exitTitle(a, rules)}
                  </span>
                  <span className={`bt-result num${tone(a.pnl)}`}>
                    {signedUsd(a.pnl)}{" "}
                    <span className="small">({signedPct(a.retPct)})</span>
                  </span>
                </>
              ) : (
                <span className="bt-exit muted">{statusWords[a.status]}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <p className="muted small">
        Times in {israelLabel}. Open a trade for its chart, why it entered and
        each exit.
      </p>
    </section>
  );
}
