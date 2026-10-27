import { useEffect, useId, useRef, useState } from "react";
import { useBoxWidth } from "./use-width.js";
import {
  mapTicks,
  panDomain,
  zoomDomain,
  type Domain,
} from "./bot-map-model.js";

// The bots' maps (the Main bot's signal map, the volume bot's alert map):
// every watched stock placed by the bot's two checks, the corners where it
// acts shaded. User 2026-10-27: zoom in, refresh every 2 seconds, a mark on
// the stocks the bot is in a trade on, and a tap on a stock opens its page.

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

export function BotMap({
  points,
  axes,
  selected,
  onOpen,
}: {
  points: MapPoint[];
  axes: MapAxes;
  selected: string | null;
  // The stock's own page; without it a tap does nothing.
  onOpen?: (symbol: string) => void;
}) {
  const box = useBoxWidth(640);
  const mapW = Math.max(300, Math.min(760, box.width));
  const mapH = mapW < 520 ? 320 : 340;
  const right = mapW - pad.r;
  const bottom = mapH - pad.b;
  const full: Domain = {
    x0: 0,
    x1: axes.xMax,
    y0: -axes.yMax,
    y1: axes.yMax,
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
    pad.l + ((Math.min(v, full.x1) - d.x0) / (d.x1 - d.x0)) * plotW;
  const y = (v: number) =>
    pad.t +
    ((d.y1 - Math.max(full.y0, Math.min(full.y1, v))) / (d.y1 - d.y0)) * plotH;
  const xTicks = zoomed ? mapTicks(d.x0, d.x1, axes.needX) : axes.xTicks;
  const yTicks = zoomed ? mapTicks(d.y0, d.y1, axes.needY, true) : axes.yTicks;
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
      latest.current.zoomAt(e.deltaY < 0 ? 1.25 : 1 / 1.25, at.x, at.y);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const centre = { x: (d.x0 + d.x1) / 2, y: (d.y0 + d.y1) / 2 };
  return (
    <div ref={box.ref} className="bot-map-box">
      <div className="bot-map-zoom" role="group" aria-label="Zoom the map">
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => zoomAt(1.6, centre.x, centre.y)}
        >
          +
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          disabled={!zoomed}
          onClick={() => zoomAt(1 / 1.6, centre.x, centre.y)}
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
              zoomAt(after / before, mid.x, mid.y);
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
          zoomAt(2, at.x, at.y);
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
            y={y(full.y1)}
            width={Math.max(0, x(full.x1) - x(axes.needX))}
            height={Math.max(0, y(axes.needY) - y(full.y1))}
          />
          <rect
            className="bot-map-zone down"
            x={x(axes.needX)}
            y={y(-axes.needY)}
            width={Math.max(0, x(full.x1) - x(axes.needX))}
            height={Math.max(0, y(full.y0) - y(-axes.needY))}
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
                role={onOpen ? "link" : undefined}
                onClick={() => {
                  if (!moved.current) onOpen?.(p.symbol);
                }}
              >
                <title>
                  {p.trade
                    ? `${p.symbol}: the bot holds a ${p.trade === "C" ? "call" : "put"}. ${p.title}`
                    : p.title}
                </title>
                <circle className="bot-dot-hit" cx={cx} cy={cy} r={12} />
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
