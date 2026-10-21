import type { ExitResult } from "./exit.js";
import type { LadderResult } from "./ladder.js";
import type { EntryNote, ExitNote, StopFill } from "./message.js";
import { NoNotifier, type Notifier, type Sent } from "./notifier.js";

// One trader's notification channels as one Notifier
// (docs/features/multi-user-ibkr.md, "Notification channels"). Each channel
// gets the events it subscribed to. The first channel that takes an event
// answers for it: its `ref` is what a later exit is attached to. A failed
// channel never blocks or undoes an order; it is logged.

export const channelEvents = [
  "entry",
  "exit",
  "stop_out",
  "notice",
  "alert",
] as const;
export type ChannelEvent = (typeof channelEvents)[number];

export interface Subscribed {
  name: string; // for the log, such as "telegram 3f2a"
  notifier: Notifier;
  events: readonly ChannelEvent[] | null; // null: every event
}

export class FanOutNotifier implements Notifier {
  constructor(
    private readonly channels: readonly Subscribed[],
    private readonly log: (line: string) => void = () => {},
  ) {}

  private async send(
    event: ChannelEvent,
    call: (n: Notifier, first: boolean) => Promise<Sent>,
  ): Promise<Sent> {
    const targets = this.channels.filter(
      (c) => c.events === null || c.events.includes(event),
    );
    if (targets.length === 0) return new NoNotifier().alert();
    const results = await Promise.all(
      targets.map((c, i) =>
        call(c.notifier, i === 0).catch((error: unknown): Sent => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })),
      ),
    );
    results.forEach((r, i) => {
      if (!r.ok) this.log(`${targets[i]!.name}: ${event} not sent: ${r.error}`);
    });
    return results[0]!;
  }

  // A post's ref belongs to the channel that made it, so only the first
  // channel gets it; the others post without a reply.
  entry(note: EntryNote, result: LadderResult, entryRef?: string) {
    return this.send("entry", (n, first) =>
      n.entry(note, result, first ? entryRef : undefined),
    );
  }
  exit(note: ExitNote, result: ExitResult, entryRef?: string) {
    return this.send("exit", (n, first) =>
      n.exit(note, result, first ? entryRef : undefined),
    );
  }
  stopped(
    note: { symbol: string; paper: boolean },
    fill: StopFill,
    entryRef?: string,
  ) {
    return this.send("stop_out", (n, first) =>
      n.stopped(note, fill, first ? entryRef : undefined),
    );
  }
  notice(title: string, lines: string[]) {
    return this.send("notice", (n) => n.notice(title, lines));
  }
  alert(title: string, lines: string[]) {
    return this.send("alert", (n) => n.alert(title, lines));
  }
}
