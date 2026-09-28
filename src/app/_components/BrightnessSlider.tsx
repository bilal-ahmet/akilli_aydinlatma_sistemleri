"use client";

interface BrightnessSliderProps {
  value: number; // 0–100
  onChange: (next: number) => void;
  disabled?: boolean;
  label: string;
  size?: "sm" | "lg";
  /** Sağdaki "%NN" değerini gizle (değer başka yerde büyük gösteriliyorsa). */
  hideValue?: boolean;
  /** Koyu "Tüm sistem" kartı üzerinde. */
  onDark?: boolean;
}

export function BrightnessSlider({
  value,
  onChange,
  disabled = false,
  label,
  size = "sm",
  hideValue = false,
  onDark = false,
}: BrightnessSliderProps) {
  const lg = size === "lg";
  const pct = Math.round(value);

  return (
    <div className="flex w-full items-center gap-3">
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuenow={pct}
        aria-valuetext={`%${pct}`}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ "--pct": `${pct}%` } as React.CSSProperties}
        className={`brightness-range w-full cursor-pointer appearance-none rounded-full bg-transparent disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-glow ${
          lg ? "h-2" : "h-1.5"
        } ${onDark ? "on-dark" : ""}`}
      />
      {hideValue ? null : (
        <span
          className={`shrink-0 text-right font-mono tabular-nums ${
            lg ? "w-16 text-2xl" : "w-11 text-sm"
          } ${disabled ? "text-muted" : "text-accent"}`}
        >
          %{pct}
        </span>
      )}
    </div>
  );
}
