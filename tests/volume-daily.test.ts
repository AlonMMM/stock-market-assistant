// SYNTHETIC alerts and books: the Volume bot's backtest data for new days,
// copied from the trader into D1 after the close (volume-daily.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteD1 } from "../apps/api/src/sqlite-d1.js";
import { StrangleStore } from "../apps/trader/src/strangle-store.js";
import { newYorkToUtc } from "../packages/market-data/src/calendar.js";
import {
  bookWindows,
  syncVolumeDay,
  type TraderBooks,
} from "../packages/market-data/src/volume-daily.js";
import { D1VolumeData } from "../packages/market-data/src/volume-data.js";

const DAY = "2026-10-29"; // a Thursday, a full session
const openMs = newYorkToUtc(DAY, 570);
const tmp = (name: string) => join(mkdtempSync(join(tmpdir(), "vday-")), name);

const books: TraderBooks = {
  day: DAY,
  symbol: "NVDA",
  second: 2400,
  kind: "shock",
  contracts: [
    { symbol: "NVDA261029C00205000" },
    { symbol: "NVDA261029P00195000" },
  ],
  samples: [
    // read 2.4 s after 09:30 + 2400 s: the book as second 2401 ended
    {
      at: openMs + 2402_400,
      books: [
        [1.0, 1.1],
        [0.5, 0.6],
      ],
    },
    { at: openMs + 2404_400, books: [null, [0.55, 0.65]] },
    {
      at: openMs + 2406_400,
      books: [
        [1.2, 0],
        [0.6, 0.7],
      ],
    }, // a zero ask: left out
  ],
};

test("volume daily: an alert's books as one window a contract, labelled the second before each read", () => {
  const w = bookWindows(books);
  assert.equal(w.length, 2);
  assert.deepEqual(w[0], {
    contract: "NVDA261029C00205000",
    date: DAY,
    start: 2401,
    end: 2401,
    rows: [[2401, 1.0, 1.1]],
  });
  assert.deepEqual(
    w[1]!.rows.map((r) => r[0]),
    [2401, 2403, 2405],
  );
});

test("volume daily: after the close the day's alerts and books go to D1 once; the backtest reads them back", async () => {
  const store = new D1VolumeData(new SqliteD1(tmp("d1.sqlite")));
  const asked: string[] = [];
  const fetcher = (async (url: URL, init?: RequestInit) => {
    asked.push(
      `${url.pathname}?${url.searchParams} ${String((init?.headers as Record<string, string>).Authorization)}`,
    );
    return Response.json({
      day: DAY,
      alerts: [
        {
          day: DAY,
          symbol: "NVDA",
          second: 2400,
          kind: "shock",
          price: 201.5,
          up: true,
        },
        {
          day: DAY,
          symbol: "AMD",
          second: 9000,
          kind: "fast",
          price: 250,
          up: false,
        },
      ],
      books: [books],
    });
  }) as unknown as typeof fetch;
  const trader = { url: "https://trader.test", token: "read-token" };
  const at = (minute: number) => newYorkToUtc(DAY, minute);
  // 16:10 New York: the trader's last samples may not be in yet.
  assert.equal(
    await syncVolumeDay({ trader, store, now: at(970), fetcher }),
    "not yet",
  );
  assert.equal(asked.length, 0);
  assert.equal(
    await syncVolumeDay({ trader, store, now: at(980), fetcher }),
    `${DAY}: 2 alerts, 2 option windows`,
  );
  assert.deepEqual(asked, [
    "/v1/strangle/alert-data?day=2026-10-29 Bearer read-token",
  ]);
  assert.equal(
    await syncVolumeDay({ trader, store, now: at(985), fetcher }),
    "done",
  );
  assert.equal(asked.length, 1);
  assert.deepEqual(await store.shocks("NVDA", DAY, DAY), [
    { date: DAY, second: 2400, price: 201.5, up: true },
  ]);
  // The 60-second alert is kept under its own kind, not as a shock.
  assert.deepEqual(await store.shocks("AMD", DAY, DAY), []);
  assert.deepEqual(await store.option("NVDA261029P00195000", DAY, 2398, 2414), [
    { s: 2401, bid: 0.5, ask: 0.6 },
    { s: 2403, bid: 0.55, ask: 0.65 },
    { s: 2405, bid: 0.6, ask: 0.7 },
  ]);
  // A weekend is not a session; no trader configured says so.
  assert.equal(
    await syncVolumeDay({
      trader,
      store,
      now: newYorkToUtc("2026-10-31", 980),
      fetcher,
    }),
    "not a session",
  );
  const other = new D1VolumeData(new SqliteD1(tmp("d2.sqlite")));
  assert.equal(
    await syncVolumeDay({ trader: {}, store: other, now: at(980), fetcher }),
    "the trader is not configured",
  );
});

test("trader: every fired 10-second alert is kept once a slot, traded or not", () => {
  const s = new StrangleStore(tmp("t.sqlite"));
  const a = {
    day: DAY,
    symbol: "NVDA",
    second: 2400,
    kind: "shock" as const,
    price: 201.5,
    up: true,
  };
  s.saveFastAlert(a);
  s.saveFastAlert({ ...a, price: 999 }); // the same slot again (a restart): the first stays
  s.saveFastAlert({ ...a, second: 1200, kind: "fast", up: false });
  assert.deepEqual(s.fastAlerts(DAY), [
    { ...a, second: 1200, kind: "fast", up: false },
    a,
  ]);
  assert.deepEqual(s.fastAlerts("2026-10-30"), []);
});
