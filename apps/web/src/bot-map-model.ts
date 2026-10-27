// The bots' map zoom (user 2026-10-27: "Let me ability to zoom"): the part
// of the map in view, in the checks' own units, zoomed and moved inside the
// whole map.

export interface Domain {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

// Zoomed in at most this many times.
const maxZoom = 20;

/** Slide [a, b] inside [lo, hi] without changing its width. */
function inside(
  a: number,
  b: number,
  lo: number,
  hi: number,
): [number, number] {
  if (a < lo) return [lo, lo + (b - a)];
  if (b > hi) return [hi - (b - a), hi];
  return [a, b];
}

/**
 * The view zoomed by `factor` (above 1: in) around the point (cx, cy), kept
 * inside the whole map; null once it shows the whole map again.
 */
export function zoomDomain(
  view: Domain,
  full: Domain,
  factor: number,
  cx: number,
  cy: number,
): Domain | null {
  const fullW = full.x1 - full.x0;
  const fullH = full.y1 - full.y0;
  const w = Math.min(
    fullW,
    Math.max(fullW / maxZoom, (view.x1 - view.x0) / factor),
  );
  const h = Math.min(
    fullH,
    Math.max(fullH / maxZoom, (view.y1 - view.y0) / factor),
  );
  if (w >= fullW * 0.999 && h >= fullH * 0.999) return null;
  // The point under the fingers stays where it is.
  const kx = w / (view.x1 - view.x0);
  const ky = h / (view.y1 - view.y0);
  const [x0, x1] = inside(
    cx - (cx - view.x0) * kx,
    cx - (cx - view.x0) * kx + w,
    full.x0,
    full.x1,
  );
  const [y0, y1] = inside(
    cy - (cy - view.y0) * ky,
    cy - (cy - view.y0) * ky + h,
    full.y0,
    full.y1,
  );
  return { x0, x1, y0, y1 };
}

/** The view moved by (dx, dy), kept inside the whole map. */
export function panDomain(
  view: Domain,
  full: Domain,
  dx: number,
  dy: number,
): Domain | null {
  if (view === full) return null;
  const [x0, x1] = inside(view.x0 + dx, view.x1 + dx, full.x0, full.x1);
  const [y0, y1] = inside(view.y0 + dy, view.y1 + dy, full.y0, full.y1);
  return { x0, x1, y0, y1 };
}

const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5];

/**
 * Round ticks for the part in view (about four), with the bot's threshold
 * (and its negative on the signed axis) always among them when in view.
 */
export function mapTicks(
  a: number,
  b: number,
  need: number,
  signed = false,
): number[] {
  const step = steps.find((s) => (b - a) / s <= 5) ?? steps.at(-1)!;
  const out = new Set<number>();
  for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step)
    out.add(Number(v.toFixed(4)));
  for (const n of signed ? [need, -need] : [need]) {
    if (n < a || n > b) continue;
    // The threshold replaces a round tick too close to it.
    for (const v of out) if (Math.abs(v - n) < step / 3) out.delete(v);
    out.add(n);
  }
  return [...out].sort((p, q) => p - q);
}
