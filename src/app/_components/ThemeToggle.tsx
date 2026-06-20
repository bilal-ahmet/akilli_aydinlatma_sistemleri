"use client";

import { useTheme } from "./ThemeProvider";
import type { ThemeMode } from "@/app/_lib/types";

const OPTIONS: { mode: ThemeMode; label: string; icon: string }[] = [
  { mode: "light", label: "Gündüz", icon: "☀" },
  { mode: "dark", label: "Gece", icon: "☾" },
  { mode: "auto", label: "Otomatik", icon: "◐" },
];

export function ThemeToggle() {
  const { mode, setMode } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Tema seçimi"
      className="inline-flex items-center gap-0.5 rounded-full border border-border bg-panel-2 p-0.5"
    >
      {OPTIONS.map((opt) => {
        const active = mode === opt.mode;
        return (
          <button
            key={opt.mode}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setMode(opt.mode)}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              active
                ? "bg-glow/15 text-accent"
                : "text-muted hover:text-text"
            }`}
          >
            <span aria-hidden className="text-sm leading-none">
              {opt.icon}
            </span>
            <span className="hidden sm:inline">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
