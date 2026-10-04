import type { AlertVsSpy } from "../../contracts/src/vs-spy.js";
import type { Evaluation } from "./relative-volume.js";

// A new live alert, after it is stored. Each (ticker, end) is published once.
// `synthetic` marks a made-up alert for checking consumers end to end; it is
// never stored as an alert and consumers that act on markets must ignore it.
// `vsSpy` is the score vs SPY at alert time, attached before it is stored and
// published (absent on alerts stored before docs/features/alert-vs-spy.md).
export type AlertEvent = Evaluation & {
  close?: number;
  synthetic?: true;
  vsSpy?: AlertVsSpy;
};

export type AlertListener = (alert: AlertEvent) => void | Promise<void>;

// In-process fan-out of live alerts. The producer does not know its
// consumers; a failing consumer is logged and never affects the producer or
// the other consumers.
export class AlertEvents {
  private listeners = new Map<string, AlertListener>();
  // `name` identifies the consumer in logs.
  subscribe(name: string, listener: AlertListener): () => void {
    if (this.listeners.has(name))
      throw new Error(`Alert listener "${name}" is already subscribed`);
    this.listeners.set(name, listener);
    return () => this.listeners.delete(name);
  }
  publish(alert: AlertEvent) {
    for (const [name, listener] of this.listeners) {
      const fail = (error: unknown) =>
        console.error(
          JSON.stringify({
            event: "alert-listener-failed",
            listener: name,
            ticker: alert.ticker,
            end: alert.end,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      try {
        const result = listener(alert);
        if (result instanceof Promise) result.catch(fail);
      } catch (error) {
        fail(error);
      }
    }
  }
}
