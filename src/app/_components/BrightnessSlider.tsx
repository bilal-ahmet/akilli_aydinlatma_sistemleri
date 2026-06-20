"use client";

interface BrightnessSliderProps {
  value: number; // 0–100
  onChange: (next: number) => void;
  disabled?: boolean;
  label: string;
  size?: "sm" | "lg";
}

export function BrightnessSlider({
  value,
  onChange,
  disabled = false,
  label,
  size = "sm",
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
        style={
          {
            "--pct": `${pct}%`,
          } as React.CSSProperties
        }
        className={`brightness-range w-full cursor-pointer appearance-none rounded-full bg-transparent disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
          lg ? "h-3" : "h-2"
        }`}
      />
      <span
        className={`shrink-0 font-mono tabular-nums text-right ${
          lg ? "w-16 text-2xl" : "w-11 text-sm"
        } ${disabled ? "text-muted" : "text-accent"}`}
      >
        %{pct}
      </span>
    </div>
  );
}
