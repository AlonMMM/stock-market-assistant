import { useEffect, useId, useRef, useState } from "react";
import { useBoxWidth } from "./use-width.js";
import {
  mapTicks,
  panDomain,
  scaleX,
  scaleY,
  unscaleX,
  unscaleY,
  zoomDomain,
  type Domain,
} from "./bot-map-model.js";

// The bots' maps (the Main bot's signal map, the volume bot's alert map):
// every watched stock placed by the bot's two checks, the corners where it
// acts shaded. User 2026-10-27: zoom in, refresh every 2 seconds, a mark on
// the stocks the bot is in a trade on. A tap on a dot picks the stock in the
// list beside the map; only its name opens its page (user 2026-10-27).

export interface MapPoint {
  symbol: string;
  x: number; // the horizontal check (volume against usual)
  y: number; // the vertical check, signed: up above the middle
  tone: "up" | "down" | "blocked";
  ring: boolean; // today's signal, or waiting for its side
  trade: "C" | "P" | null; // the bot holds a call or a put on it now
  title: string;
}

export interface MapAxes {
  xMax: number;
  yMax: number; // the vertical axis runs from −yMax to yMax
  needX: number;
  needY: number;
  xTicks: number[];
  yTicks: number[];
  yTick: (v: number) => string;
  zones: [string, string]; // the up and down corners' names
  xTitle: string;
  yTitle: string;
  label: string; // what the map shows, for a screen reader
}

const pad = { l: 40, r: 14, t: 14, b: 34 };
// A tap moves less than this; more is a drag.
const tapPx = 6;
// Zoom steps: the buttons and a double tap, and how fast a wheel or a pinch
// zooms (it was too sensitive, user 2026-10-27).
const buttonStep = 1.3;
const doubleTapStep = 1.5;
const wheelRate = 0.0015; // per pixel of wheel
const pinchDamp = 0.7; // power on the fingers' spread ratio

/**
 * The stock picked on a bot's map or in its list, and the scrolling that
 * links the two: picked in the list, the map scrolls into view; picked on
 * the map, its row scrolls into view when the list sits beside the map.
 */
export function useMapPick() {
  const [pick, setPick] = useState<{
    symbol: string;
    from: "map" | "list";
    n: number;
  } | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pick) return;
    const map = mapRef.current;
    const list = listRef.current;
    if (!map || !list) return;
    const smooth = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth";
    if (pick.from === "list") {
      map.scrollIntoView({ block: "nearest", behavior: smooth });
      return;
    }
    const row = list.querySelector(`[data-symbol="${pick.symbol}"]`);
    const m = map.getBoundingClientRect();
    const beside = list.getBoundingClientRect().top < m.bottom;
    if (row && beside)
      row.scrollIntoView({ block: "nearest", behavior: smooth });
  }, [pick]);
  const pickFrom = (from: "map" | "list") => (symbol: string) =>
    setPick((p) => ({ symbol, from, n: (p?.n ?? 0) + 1 }));
  return {
    picked: pick?.symbol ?? null,
    fromMap: pickFrom("map"),
    fromList: pickFrom("list"),
    mapRef,
    listRef,
  };
}

export function BotMap({
  points,
  axes,
  selected,
  onSelect,
}: {
  points: MapPoint[];
  axes: MapAxes;
  selected: string | null;
  // A tap on a stock, its dot or its name, picks it in the list (user
  // 2026-10-28: "not to the stock page"); its page opens from the card.
  onSelect?: (symbol: string) => void;
}) {
  const box = useBoxWidth(640);
  const mapW = Math.max(300, Math.min(760, box.width));
  const mapH = mapW < 520 ? 320 : 340;
  const right = mapW - pad.r;
  const bottom = mapH - pad.b;
  // Not linear (user 2026-10-27): most stocks sit near 1× and a few far
  // out, so both axes are logarithmic; the zoom works on the scaled values.
  const full: Domain = {
    x0: 0,
    x1: scaleX(axes.xMax),
    y0: -scaleY(axes.yMax),
    y1: scaleY(axes.yMax),
  };
  const [zoom, setZoom] = useState<Domain | null>(null);
  // A new scale (another stock far out) keeps the zoom inside it.
  const d =
    zoom && zoom.x1 <= full.x1 && zoom.y0 >= full.y0 && zoom.y1 <= full.y1
      ? zoom
      : full;
  const zoomed = d === zoom;
  const clip = `bot-map-plot-${useId().replace(/:/g, "")}`;
  const plotW = right - pad.l;
  const plotH = bottom - pad.t;
  const x = (v: number) =>
    pad.l + ((scaleX(Math.min(v, axes.xMax)) - d.x0) / (d.x1 - d.x0)) * plotW;
  const y = (v: number) =>
    pad.t +
    ((d.y1 - scaleY(Math.max(-axes.yMax, Math.min(axes.yMax, v)))) /
      (d.y1 - d.y0)) *
      plotH;
  const xTicks = zoomed
    ? mapTicks(unscaleX(d.x0), unscaleX(d.x1), axes.needX)
    : axes.xTicks;
  const yTicks = zoomed
    ? mapTicks(unscaleY(d.y0), unscaleY(d.y1), axes.needY, true)
    : axes.yTicks;
  // Names on the closest stocks only, so the labels stay readable; zoomed
  // in, on every stock in view.
  const named = new Set(points.slice(0, 8).map((p) => p.symbol));
  if (selected) named.add(selected);

  // Pointers on the map: one drags (when zoomed), two pinch.
  const svg = useRef<SVGSVGElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const moved = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const toData = (clientX: number, clientY: number) => {
    const rect = svg.current!.getBoundingClientRect();
    const scale = mapW / rect.width;
    const px = (clientX - rect.left) * scale;
    const py = (clientY - rect.top) * scale;
    return {
      x: d.x0 + ((px - pad.l) / plotW) * (d.x1 - d.x0),
      y: d.y1 - ((py - pad.t) / plotH) * (d.y1 - d.y0),
      scale,
    };
  };
  const zoomAt = (factor: number, cx: number, cy: number) =>
    setZoom((z) => zoomDomain(z ?? full, full, factor, cx, cy));

  // The wheel zooms (a listener that may stop the page from scrolling).
  const latest = useRef({ zoomAt, toData });
  latest.current = { zoomAt, toData };
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const at = latest.current.toData(e.clientX, e.clientY);
      // Proportional to the wheel's travel, so a trackpad's many small
      // events don't race; lines count as 16 pixels.
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const factor = Math.min(1.25, Math.max(0.8, Math.exp(-px * wheelRate)));
      latest.current.zoomAt(factor, at.x, at.y);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const centre = { x: (d.x0 + d.x1) / 2, y: (d.y0 + d.y1) / 2 };
  // A stock picked in the list while zoomed elsewhere: pan to its dot.
  const target = points.find((p) => p.symbol === selected);
  const tx = target ? scaleX(Math.min(target.x, axes.xMax)) : null;
  const ty = target
    ? scaleY(Math.max(-axes.yMax, Math.min(axes.yMax, target.y)))
    : null;
  useEffect(() => {
    if (tx === null || ty === null) return;
    setZoom((z) => {
      if (!z) return z;
      const inside = tx >= z.x0 && tx <= z.x1 && ty >= z.y0 && ty <= z.y1;
      if (inside) return z;
      return panDomain(z, full, tx - (z.x0 + z.x1) / 2, ty - (z.y0 + z.y1) / 2);
    });
    // Only a new pick moves the view, not the 2-second refresh.
  }, [selected]);
  return (
    <div ref={box.ref} className="bot-map-box">
      <div className="bot-map-zoom" role="group" aria-label="Zoom the map">
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => zoomAt(buttonStep, centre.x, centre.y)}
        >
          +
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          disabled={!zoomed}
          onClick={() => zoomAt(1 / buttonStep, centre.x, centre.y)}
        >
          −
        </button>
        {zoomed && (
          <button type="button" onClick={() => setZoom(null)}>
            Fit
          </button>
        )}
      </div>
      <svg
        ref={svg}
        className={`bot-map${zoomed ? " zoomed" : ""}`}
        viewBox={`0 0 ${mapW} ${mapH}`}
        width="100%"
        role="img"
        aria-label={axes.label}
        onPointerDown={(e) => {
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.current.size === 1) {
            moved.current = false;
            start.current = { x: e.clientX, y: e.clientY };
          }
        }}
        onPointerMove={(e) => {
          const last = pointers.current.get(e.pointerId);
          if (!last) return;
          const now = { x: e.clientX, y: e.clientY };
          if (
            start.current &&
            Math.hypot(now.x - start.current.x, now.y - start.current.y) > tapPx
          )
            moved.current = true;
          if (pointers.current.size === 2) {
            // Pinch: the spread between the two fingers zooms.
            const other = [...pointers.current.entries()].find(
              ([id]) => id !== e.pointerId,
            )![1];
            const before = Math.hypot(last.x - other.x, last.y - other.y);
            const after = Math.hypot(now.x - other.x, now.y - other.y);
            if (before > 0) {
              const mid = toData((now.x + other.x) / 2, (now.y + other.y) / 2);
              zoomAt((after / before) ** pinchDamp, mid.x, mid.y);
            }
            moved.current = true;
          } else if (zoomed && pointers.current.size === 1) {
            const a = toData(last.x, last.y);
            const b = toData(now.x, now.y);
            setZoom((z) => panDomain(z ?? full, full, a.x - b.x, a.y - b.y));
          }
          pointers.current.set(e.pointerId, now);
        }}
        onPointerUp={(e) => pointers.current.delete(e.pointerId)}
        onPointerCancel={(e) => pointers.current.delete(e.pointerId)}
        onDoubleClick={(e) => {
          const at = toData(e.clientX, e.clientY);
          zoomAt(doubleTapStep, at.x, at.y);
        }}
      >
        <defs>
          <clipPath id={clip}>
            <rect x={pad.l} y={pad.t} width={plotW} height={plotH} />
          </clipPath>
        </defs>
        <g clipPath={zoomed ? `url(#${clip})` : undefined}>
          <rect
            className="bot-map-zone up"
            x={x(axes.needX)}
            y={y(axes.yMax)}
            width={Math.max(0, x(axes.xMax) - x(axes.needX))}
            height={Math.max(0, y(axes.needY) - y(axes.yMax))}
          />
          <rect
            className="bot-map-zone down"
            x={x(axes.needX)}
            y={y(-axes.needY)}
            width={Math.max(0, x(axes.xMax) - x(axes.needX))}
            height={Math.max(0, y(-axes.yMax) - y(-axes.needY))}
          />
          {yTicks.map((t) => (
            <line
              key={`t${t}`}
              className={
                Math.abs(t) === axes.needY ? "bot-map-need" : "bot-map-grid"
              }
              x1={pad.l}
              x2={right}
              y1={y(t)}
              y2={y(t)}
            />
          ))}
          {xTicks.map((v) => (
            <line
              key={`v${v}`}
              className={v === axes.needX ? "bot-map-need" : "bot-map-grid"}
              x1={x(v)}
              x2={x(v)}
              y1={pad.t}
              y2={bottom}
            />
          ))}
        </g>
        {!zoomed && (
          <>
            <text
              className="bot-map-zone-label up"
              x={right - 6}
              y={pad.t + 16}
              textAnchor="end"
            >
              {axes.zones[0]}
            </text>
            <text
              className="bot-map-zone-label down"
              x={right - 6}
              y={bottom - 8}
              textAnchor="end"
            >
              {axes.zones[1]}
            </text>
          </>
        )}
        {yTicks.map((t) => (
          <text
            key={`tl${t}`}
            className="bot-map-tick"
            x={pad.l - 6}
            y={y(t) + 4}
            textAnchor="end"
          >
            {axes.yTick(t)}
          </text>
        ))}
        {xTicks.map((v) => (
          <text
            key={`vl${v}`}
            className="bot-map-tick"
            x={x(v)}
            y={bottom + 14}
            textAnchor="middle"
          >
            {Number(v.toFixed(2))}×
          </text>
        ))}
        <text
          className="bot-map-axis"
          x={(pad.l + right) / 2}
          y={mapH - 3}
          textAnchor="middle"
        >
          {axes.xTitle}
        </text>
        <text
          className="bot-map-axis"
          transform={`translate(11 ${(pad.t + bottom) / 2}) rotate(-90)`}
          textAnchor="middle"
        >
          {axes.yTitle}
        </text>
        <g clipPath={zoomed ? `url(#${clip})` : undefined}>
          {points.map((p) => {
            const cx = x(p.x);
            const cy = y(p.y);
            const isSelected = selected === p.symbol;
            const inView =
              cx >= pad.l && cx <= right && cy >= pad.t && cy <= bottom;
            const name = named.has(p.symbol) || p.trade || (zoomed && inView);
            return (
              <g
                key={p.symbol}
                className={`bot-dot ${p.tone}${isSelected ? " selected" : ""}${p.trade ? " in-trade" : ""}`}
                onClick={() => {
                  if (!moved.current) onSelect?.(p.symbol);
                }}
              >
                <title>
                  {p.trade
                    ? `${p.symbol}: the bot holds a ${p.trade === "C" ? "call" : "put"}. ${p.title}`
                    : p.title}
                </title>
                <circle className="bot-dot-hit" cx={cx} cy={cy} r={12} />
                {isSelected && (
                  <circle className="bot-dot-halo" cx={cx} cy={cy} r={13} />
                )}
                {p.trade && (
                  <rect
                    className={`bot-dot-trade ${p.trade === "C" ? "up" : "down"}`}
                    x={cx - 10}
                    y={cy - 10}
                    width={20}
                    height={20}
                    rx={4}
                    transform={`rotate(45 ${cx} ${cy})`}
                  />
                )}
                {p.ring && (
                  <circle className="bot-dot-ring" cx={cx} cy={cy} r={10} />
                )}
                <circle cx={cx} cy={cy} r={isSelected ? 7 : 5} />
                {name && (
                  <text x={cx + 12} y={cy + 4}>
                    {p.trade ? `◆ ${p.symbol}` : p.symbol}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
