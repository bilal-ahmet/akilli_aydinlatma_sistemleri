"use client";

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  size?: "sm" | "lg";
  disabled?: boolean;
  /** Koyu "Tüm sistem" kartı üzerinde: kapalı iz açık tema rengine dönmesin. */
  onDark?: boolean;
}

/** Aç/kapa anahtarı — açıkken amber iz + ışıma, düğme her zaman beyaz. */
export function Toggle({
  checked,
  onChange,
  label,
  size = "sm",
  disabled = false,
  onDark = false,
}: ToggleProps) {
  const lg = size === "lg";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex shrink-0 items-center rounded-full transition-[background-color,box-shadow] duration-300 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-glow ${
        lg ? "h-[30px] w-[52px] p-[3px]" : "h-5 w-9 p-[2px]"
      } ${
        checked
          ? "bg-glow shadow-[0_0_16px_oklch(0.77_0.16_68/0.6)]"
          : onDark
            ? "bg-white/15"
            : "bg-border-strong"
      }`}
    >
      <span
        className={`inline-block rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,.25)] transition-transform duration-300 ease-out ${
          lg ? "h-6 w-6" : "h-4 w-4"
        } ${checked ? (lg ? "translate-x-[22px]" : "translate-x-4") : "translate-x-0"}`}
      />
    </button>
  );
}
