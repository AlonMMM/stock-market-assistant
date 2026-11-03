// Retrying a backtest part when the connection, not the part, failed (the
// user, 2026-11-03: 16 parts of a 200-part run ended on "Failed to fetch").
// "Failed to fetch" is the browser's TypeError for a request that got no
// response at all: the phone changed network, the tab slept, the connection
// was cut. The part itself was fine, so it is asked again after a pause. An
// answer from the server (a bad request, a missing stock) is not retried.

/** The pauses before each new attempt; one attempt more than pauses. */
export const retryDelaysMs = [3000, 10000, 30000] as const;

/** A server answer that says "busy or cut off, try again" (gateway, limit). */
export class TransientHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TransientHttpError";
  }
}

/** HTTP statuses worth asking again: the gateway or the Worker, not the part. */
export const transientStatus = (status: number): boolean =>
  status === 429 ||
  status === 502 ||
  status === 503 ||
  status === 504 ||
  status >= 520;

/** True for a failure of the connection rather than of the request. */
export function isTransient(e: unknown): boolean {
  if (e instanceof TransientHttpError) return true;
  // fetch's network failure: "Failed to fetch" (Chrome), "Load failed"
  // (Safari), "NetworkError when attempting to fetch resource." (Firefox).
  if (e instanceof TypeError) return true;
  // The part's own timeout (AbortSignal.timeout), not the user's Stop.
  return e instanceof Error && e.name === "TimeoutError";
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs `attempt` until it succeeds, fails for a reason not worth retrying,
 * or the pauses run out; then the last error is thrown. `signal` (the user's
 * Stop) ends a pause at once and is never retried.
 */
export async function withRetries<T>(
  attempt: () => Promise<T>,
  o: {
    signal?: AbortSignal;
    delaysMs?: readonly number[];
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<T> {
  const delays = o.delaysMs ?? retryDelaysMs;
  const wait = o.wait ?? pause;
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (o.signal?.aborted || i >= delays.length || !isTransient(e)) throw e;
      await wait(delays[i]!, o.signal);
    }
  }
}
