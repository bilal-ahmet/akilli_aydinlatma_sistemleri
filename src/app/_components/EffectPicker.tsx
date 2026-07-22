"use client";

import { useState } from "react";
import {
  EFFECTS,
  MORSE_TEXT_MAX,
  normalizeMorseText,
  type Effect,
} from "@/lib/effects";
import { Modal } from "./Modal";

interface EffectPickerProps {
  open: boolean;
  title: string;
  activeFx?: number | null;
  onClose: () => void;
  /** `text` yalnızca metin bekleyen efektlerde (Mors) dolu gelir. */
  onPick: (number: number, text?: string) => void;
  onStop: () => void;
}

export function EffectPicker({ open, title, activeFx, onClose, onPick, onStop }: EffectPickerProps) {
  // Metin bekleyen bir efekt seçildiğinde grid yerine metin adımı gösterilir.
  const [textFx, setTextFx] = useState<Effect | null>(null);
  const [text, setText] = useState("");

  function close() {
    setTextFx(null);
    onClose();
  }

  function pick(fx: Effect) {
    if (fx.needsText) {
      setText("");
      setTextFx(fx);
      return;
    }
    onPick(fx.number);
  }

  function startTextEffect() {
    if (!textFx) return;
    // Boş bırakıldıysa `text` hiç gönderilmez → cihaz son metni tekrar çalar.
    onPick(textFx.number, text || undefined);
    setTextFx(null);
  }

  return (
    <Modal open={open} onClose={close} title={textFx ? `${title} · ${textFx.label}` : title}>
      {textFx ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{textFx.desc}</p>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted" htmlFor="fx-morse-text">
              Çalınacak metin
            </label>
            <input
              id="fx-morse-text"
              autoFocus
              value={text}
              maxLength={MORSE_TEXT_MAX}
              onChange={(e) => setText(normalizeMorseText(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter") startTextEffect();
              }}
              placeholder="MERHABA"
              className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 font-mono text-sm tracking-wider text-text outline-none focus-visible:border-accent"
            />
            <p className="mt-1 flex justify-between gap-2 text-[11px] text-muted">
              <span>
                Harf, rakam ve boşluk. Türkçe harfler ASCII karşılığına çevrilir (Ş→S).
              </span>
              <span className="shrink-0 font-mono">
                {text.length}/{MORSE_TEXT_MAX}
              </span>
            </p>
            <p className="mt-1 text-[11px] text-muted">
              Boş bırakırsan cihaz en son ayarlanan metni tekrar çalar.
            </p>
          </div>
          <div className="mt-1 flex justify-between gap-2">
            <button
              type="button"
              onClick={() => setTextFx(null)}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-text"
            >
              Geri
            </button>
            <button
              type="button"
              onClick={startTextEffect}
              className="rounded-lg border border-glow/40 bg-glow/20 px-4 py-2 text-sm font-semibold text-text transition-colors hover:bg-glow/30"
            >
              Başlat
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid max-h-[55vh] grid-cols-2 gap-2 overflow-y-auto pr-1">
            {EFFECTS.map((fx) => {
              const active = activeFx === fx.number;
              return (
                <button
                  key={fx.number}
                  type="button"
                  onClick={() => pick(fx)}
                  className={`flex flex-col gap-0.5 rounded-xl border p-3 text-left transition-colors ${
                    active
                      ? "border-glow/60 bg-glow/20"
                      : "border-border bg-panel-2 hover:border-glow/40 hover:bg-glow/10"
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-text">
                    <span className="font-mono text-[11px] text-muted">{fx.number}</span>
                    {fx.label}
                    {fx.needsText ? (
                      <span className="rounded-md bg-panel px-1 py-0.5 text-[9px] font-medium text-muted">
                        metin
                      </span>
                    ) : null}
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
              onClick={close}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-text"
            >
              Kapat
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
