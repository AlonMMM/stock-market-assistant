// What the trading service answers at GET /v1/strangle (the site's
// /api/strangle), for the app's Alert leg tab (docs/tasks/backend-strangle-bot.md).
import type { StrangleSettings } from "./settings.js";

export interface StrangleOrderView {
  at: number;
  side: "buy" | "sell";
  qty: number;
  reason: string;
  jobId: string | null;
  settled: boolean;
  price?: number;
}

export interface StrangleLegView {
  contract: string;
  strike: number;
  qty: number;
  bought: number;
  cost: number;
  orders: StrangleOrderView[];
}

export interface StrangleTradeView {
  id: string;
  day: string;
  symbol: string;
  alertMinute: number;
  alertSide: "up" | "down";
  unit: number;
  stockRef: number;
  side: "C" | "P" | null;
  sideMinute: number | null;
  best: number | null;
  leg: StrangleLegView | null;
  phase: "watching" | "buying" | "open" | "closing" | "closed";
  closeReason: string | null;
  dry: boolean;
  openedAt: number;
  closedAt: number | null;
  paid: number;
  got: number;
  marks: { leg: number | null; stock: number | null; at: number } | null;
  openValue: number | null;
  // Open trades only (watching to closing): the stock's minute closes from
  // the alert minute on, [session minute, close], for the app's small charts.
  path?: [number, number][];
}

/** One watched stock's alert checks at the last closed minute (alert.ts measureAt). */
export interface StrangleScanRow {
  symbol: string;
  minute: number;
  volRatio: number;
  moveRatio: number;
  shares: number;
  movePct: number;
  side: "up" | "down";
}

/** The live (not dry) trades' result per day, since the first. */
export interface StrangleLiveDay {
  day: string;
  pnl: number; // closed trades' got − paid, plus open trades at their mark
  trades: number;
  winners: number;
}

export interface StrangleView {
  enabled: boolean;
  mode: "live" | "dry";
  account: string;
  settings: StrangleSettings;
  steps: { name: string; text: string }[];
  lastWork: number | null;
  day: string | null;
  watching: string[];
  favorites: { name: string; count: number; at: number } | null;
  news: { earnings: string; premarket: string };
  signals: {
    day: string;
    symbol: string;
    minute: number;
    side: "up" | "down";
    outcome: string;
    detail: string;
    at: number;
  }[];
  open: StrangleTradeView[];
  trades: StrangleTradeView[];
  events: { at: number; kind: string; text: string }[];
  // Every watched stock with data at the last closed minute, closest to an
  // alert first (alert.ts alertCloseness); empty before the first minute.
  scan: StrangleScanRow[];
  // The account's value when the bot's day started (its day-loss limit's base).
  dayStartEquity: number | null;
  // The live trades' result per day, since the first.
  live: StrangleLiveDay[];
  // Watched stocks with no option expiring today (nor the next session when
  // 1DTE days are on): they can alert but never trade today. Checked once
  // when the day starts; a stock whose chain could not be read is not listed.
  noExpiry: string[];
}
