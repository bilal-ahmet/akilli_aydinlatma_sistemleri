"use client";

import { EFFECTS } from "@/lib/effects";
import { Modal } from "./Modal";

interface EffectPickerProps {
  open: boolean;
  title: string;
  activeFx?: number | null;
  onClose: () => void;
  onPick: (number: number) => void;
  onStop: () => void;
}

export function EffectPicker({ open, title, activeFx, onClose, onPick, onStop }: EffectPickerProps) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="grid max-h-[55vh] grid-cols-2 gap-2 overflow-y-auto pr-1">
        {EFFECTS.map((fx) => {
          const active = activeFx === fx.number;
          return (
            <button
              key={fx.number}
              type="button"
              onClick={() => onPick(fx.number)}
              className={`flex flex-col gap-0.5 rounded-xl border p-3 text-left transition-colors ${
                active
                  ? "border-glow/60 bg-glow/20"
                  : "border-border bg-panel-2 hover:border-glow/40 hover:bg-glow/10"
              }`}
            >
              <span className="flex items-center gap-1.5 text-sm font-semibold text-text">
                <span className="font-mono text-[11px] text-muted">{fx.number}</span>
                {fx.label}
              </span>
              <span className="text-[11px] leading-snug text-muted">{fx.desc}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex justify-between gap-2">
        <button
          type="button"
          onClick={onStop}
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-text"
        >
          Efekti durdur
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-text"
        >
          Kapat
        </button>
      </div>
    </Modal>
  );
}
