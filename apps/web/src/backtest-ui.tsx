import { useEffect, useState, type ReactNode } from "react";

// The Backtest page's setup pieces, shared by the Main bot's and the Volume
// bot's sections.

export function Card({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const id = `bt-card-${title.toLowerCase()}`;
  return (
    <section className="card setup-card" aria-labelledby={id}>
      <div className="card-head">
        <h2 id={id}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function NumberRow({
  label,
  unit,
  value,
  min,
  max,
  step,
  changed = false,
  onChange,
}: {
  label: string;
  unit?: string | undefined;
  value: number;
  min: number;
  max: number;
  step: number;
  changed?: boolean;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className={changed ? "rule-field changed" : "rule-field"}>
      <span>
        {label}
        {unit && <span className="hint"> {unit}</span>}
      </span>
      <input
        type="number"
        inputMode="decimal"
        value={text}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (
            e.target.value !== "" &&
            Number.isFinite(v) &&
            v >= min &&
            v <= max
          )
            onChange(v);
        }}
      />
    </label>
  );
}
