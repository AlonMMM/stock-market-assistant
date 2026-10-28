// The bots' map zoom (user 2026-10-27: "Let me ability to zoom"): the part
// of the map in view, in the checks' own units, zoomed and moved inside the
// whole map.

export interface Domain {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * The map's scales (user 2026-10-27: "the scales of the map should not be
 * linear"): volume against usual on log(1 + v), so 0 to 2× gets room and 10×
 * still fits; the signed axis the same way on each side of 0.
 */
export const scaleX = (v: number) => Math.log1p(Math.max(0, v));
export const unscaleX = (u: number) => Math.expm1(u);
export const scaleY = (v: number) => Math.sign(v) * Math.log1p(Math.abs(v));
export const unscaleY = (u: number) => Math.sign(u) * Math.expm1(Math.abs(u));

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

/**
 * How far a stock's dot sits from its corner on the map (user 2026-10-28:
 * the list "is not sorting from the place that are close to the alerts"):
 * the gap on each axis in the map's own scales, as a share of that axis, so
 * the list follows what the map shows. 0 inside the corner.
 */
export function cornerGap(
  x: number,
  y: number, // the vertical check's size; its side does not matter
  needX: number,
  needY: number,
  xMax: number,
  yMax: number,
): number {
  const gx =
    Math.max(0, scaleX(needX) - scaleX(Math.min(x, xMax))) / scaleX(xMax);
  const gy =
    Math.max(0, scaleY(needY) - scaleY(Math.min(Math.abs(y), yMax))) /
    (2 * scaleY(yMax));
  return Math.hypot(gx, gy);
}

/**
 * Nearest its corner first; of the stocks inside one, the deepest first (the
 * larger of the weaker check against its need).
 */
export function byCorner<T>(
  rows: readonly T[],
  gap: (r: T) => number,
  depth: (r: T) => number,
): T[] {
  return [...rows]
    .map((r) => ({ r, g: gap(r), d: depth(r) }))
    .sort((a, b) => a.g - b.g || b.d - a.d)
    .map((e) => e.r);
}
