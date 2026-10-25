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
}
