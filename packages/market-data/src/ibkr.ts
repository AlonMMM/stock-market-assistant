import {
  IBApi,
  EventName,
  BarSizeSetting,
  WhatToShow,
  SecType,
} from "@stoqey/ib";
import type { RawBar } from "./bars.js";

interface Request {
  rows: RawBar[];
  resolve: (rows: RawBar[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  update?: (bar: RawBar) => void;
}
// Deliberately exposes only market-data operations; no account/order methods.
export class IbkrFeed {
  private ib: IBApi;
  private id = 1;
  private requests = new Map<number, Request>();
  private failed = false;
  constructor(
    host: string,
    port: number,
    private onFailure: (message: string) => void,
    transport?: IBApi,
  ) {
    this.ib = transport ?? new IBApi({ host, port, clientId: 71 });
    this.ib.on(
      EventName.historicalData,
      (id, time, open, high, low, close, volume) => {
        const request = this.requests.get(id);
        if (!request) return;
        if (time.startsWith("finished")) {
          clearTimeout(request.timer);
          request.resolve(request.rows);
          request.rows = [];
          if (!request.update) this.requests.delete(id);
        } else
          request.rows.push({
            start: Number(time),
            open,
            high,
            low,
            close,
            volume,
          });
      },
    );
    this.ib.on(
      EventName.historicalDataUpdate,
      (id, time, open, high, low, close, volume) => {
        this.requests
          .get(id)
          ?.update?.({ start: Number(time), open, high, low, close, volume });
      },
    );
    this.ib.on(EventName.error, (_error, code, id) => {
      // Expected farm connectivity messages. Never log account-bearing payloads.
      if ([2104, 2106, 2107, 2108, 2158].includes(code)) return;
      const message = `IBKR error ${code}, request ${id}`;
      this.fail(message);
    });
    this.ib.on(EventName.disconnected, () => this.fail("IBKR disconnected"));
  }
  private fail(message: string) {
    if (this.failed) return;
    this.failed = true;
    for (const r of this.requests.values()) {
      clearTimeout(r.timer);
      r.reject(new Error(message));
    }
    this.requests.clear();
    this.onFailure(message);
  }
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("IB Gateway connection timed out")),
        20000,
      );
      this.ib.once(EventName.nextValidId, () => {
        clearTimeout(timer);
        resolve();
      });
      this.ib.connect();
    });
  }
  history(
    ticker: string,
    end: string,
    update?: (bar: RawBar) => void,
  ): Promise<RawBar[]> {
    if (this.failed)
      return Promise.reject(new Error("IBKR connection unavailable"));
    return new Promise((resolve, reject) => {
      const id = this.id++;
      const timer = setTimeout(() => {
        this.ib.cancelHistoricalData(id);
        this.requests.delete(id);
        reject(new Error(`Historical request timed out for ${ticker}`));
      }, 90000);
      this.requests.set(id, { rows: [], resolve, reject, timer, update });
      this.ib.reqHistoricalData(
        id,
        {
          symbol: ticker,
          exchange: "SMART",
          currency: "USD",
          secType: SecType.STK,
        },
        end,
        "1 D",
        BarSizeSetting.MINUTES_ONE,
        WhatToShow.TRADES,
        false,
        2,
        !!update,
      );
    });
  }
  close() {
    this.failed = true;
    for (const [id, r] of this.requests) {
      clearTimeout(r.timer);
      this.ib.cancelHistoricalData(id);
      r.reject(new Error("Collector stopping"));
    }
    this.requests.clear();
    this.ib.disconnect();
  }
}
