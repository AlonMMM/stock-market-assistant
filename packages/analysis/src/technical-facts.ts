// The technical-scan skill's numbers from its summary.json, typed for the
// Telegram message and the site. Only reads what the script wrote; every
// field is null when the script did not produce it. No Node imports: the
// website uses this too.

export interface Zone {
  level: number;
  distancePct: number;
  labels: string[];
}

export interface Divergence {
  kind: "against" | "held";
  start: string; // UTC ISO
  end: string;
  stockPp: number;
  benchmarkPp: number;
}

export interface TechnicalFacts {
  spot: number | null;
  vwap: number | null;
  pivots: Record<"pp" | "r1" | "r2" | "r3" | "s1" | "s2" | "s3", number> | null;
  priorWeek: { high: number; low: number } | null;
  volumeProfile: { poc: number; vah: number; val: number } | null;
  swings: { level: number; strength: number }[];
  benchmark: string | null;
  beta60: number | null;
  correlation60: number | null;
  beta20: number | null;
  regimeShift: number | null;
  alphaNowPp: number | null;
  alphaPositivePct: number | null;
  quadrant: string | null;
  rsRatio: number | null;
  rsMomentum: number | null;
  rsNewHigh: boolean | null;
  divergences: Divergence[];
  resistance: Zone[];
  support: Zone[];
}

// A |beta_regime_shift| above this is called out (technical-scan SKILL.md).
export const regimeShiftThreshold = 0.3;

const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const obj = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const list = (v: unknown) => (Array.isArray(v) ? v : []);
const iso = (v: unknown) => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

function zones(v: unknown): Zone[] {
  return list(v).flatMap((z) => {
    const r = obj(z);
    const level = num(r.level);
    const distancePct = num(r.distance_pct);
    if (level === null || distancePct === null) return [];
    const labels = list(r.labels).filter(
      (l): l is string => typeof l === "string",
    );
    return [{ level, distancePct, labels }];
  });
}

export function technicalFacts(summary: unknown): TechnicalFacts {
  const s = obj(summary);
  const pivots = obj(s.pivots_from_prior_day);
  const keys = ["pp", "r1", "r2", "r3", "s1", "s2", "s3"] as const;
  const week = obj(s.prior_week_range);
  const vp = obj(s.volume_profile);
  const rs = obj(s.relative_strength);
  const plan = obj(s.trade_plan);
  return {
    spot: num(s.spot),
    vwap: num(s.session_vwap_last),
    pivots: keys.every((k) => num(pivots[k]) !== null)
      ? (Object.fromEntries(keys.map((k) => [k, pivots[k]])) as Record<
          (typeof keys)[number],
          number
        >)
      : null,
    priorWeek:
      num(week.high) !== null && num(week.low) !== null
        ? { high: week.high as number, low: week.low as number }
        : null,
    volumeProfile:
      num(vp.poc) !== null &&
      num(vp.value_area_high) !== null &&
      num(vp.value_area_low) !== null
        ? {
            poc: vp.poc as number,
            vah: vp.value_area_high as number,
            val: vp.value_area_low as number,
          }
        : null,
    swings: list(s.swing_sr_clusters).flatMap((c) => {
      const r = obj(c);
      const level = num(r.level);
      const strength = num(r.strength);
      return level === null || strength === null ? [] : [{ level, strength }];
    }),
    benchmark: typeof rs.benchmark === "string" ? rs.benchmark : null,
    beta60: num(rs.beta_60d),
    correlation60: num(rs.beta_60d_correlation),
    beta20: num(rs.beta_recent),
    regimeShift: num(rs.beta_regime_shift),
    alphaNowPp: num(rs.alpha_now_pp),
    alphaPositivePct: num(rs.pct_session_alpha_positive),
    quadrant: typeof rs.rs_quadrant === "string" ? rs.rs_quadrant : null,
    rsRatio: num(rs.rs_ratio_now),
    rsMomentum: num(rs.rs_momentum_now),
    rsNewHigh:
      typeof rs.rs_line_at_new_high === "boolean"
        ? rs.rs_line_at_new_high
        : null,
    divergences: list(rs.divergence_windows).flatMap((w) => {
      const r = obj(w);
      const start = iso(r.start_time);
      const end = iso(r.end_time);
      const stockPp = num(r.stock_move_pp);
      const benchmarkPp = num(r.bench_move_pp);
      if (
        (r.class !== "against" && r.class !== "held") ||
        !start ||
        !end ||
        stockPp === null ||
        benchmarkPp === null
      )
        return [];
      return [{ kind: r.class, start, end, stockPp, benchmarkPp }];
    }),
    resistance: zones(plan.resistance_ladder),
    support: zones(plan.support_ladder),
  };
}

// Chart files the script writes, in its order, with what each shows.
export const chartTitles: Record<string, string> = {
  "01_daily.png": "Daily · pivots, swing levels, prior week",
  "02_hourly.png": "Hourly · pivots",
  "03_intraday_volume_profile.png": "5-minute · VWAP and volume profile",
  "04_options_oi.png": "Options open interest",
  "05_relative_strength.png": "Relative strength · beta-adjusted alpha",
  "06_trade_levels.png": "Level ladder around spot",
  "07_rs_rotation.png": "RS line and rotation quadrant",
};

export const chartNamePattern = /^0\d_[a-z_]+\.png$/;
