"use client";

import { useState } from "react";
import { DATE_PLACEHOLDER, displayToIsoDate, isoDateToDisplay, maskDateInput } from "@/lib/dateFormat";

/**
 * Tarih alanı: gün/ay/yıl yazılır ("03/11/2026"). Tarayıcının yerel
 * `type="date"` kutusu işletim sistemi diline göre ay/gün/yıl gösterebildiği
 * için kullanılmaz. `value`/`onChange` API biçimindedir (YYYY-MM-DD); geçersiz
 * ya da eksik girişte `onChange("")`.
 */
export function DateField({
  value,
  onChange,
  id,
  ariaLabel,
  className = "!w-52",
}: {
  value: string;
  onChange: (iso: string) => void;
  id?: string;
  ariaLabel?: string;
  className?: string;
}) {
  // Yazarken kullanıcının metni korunur; boşken (null) `value`dan türetilir.
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? isoDateToDisplay(value);
  const invalid = shown !== "" && displayToIsoDate(shown) === null;
  return (
    <input
      id={id}
      aria-label={ariaLabel}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      placeholder={DATE_PLACEHOLDER}
      maxLength={10}
      value={shown}
      aria-invalid={invalid}
      onChange={(e) => {
        const masked = maskDateInput(e.target.value);
        setText(masked);
        onChange(displayToIsoDate(masked) ?? "");
      }}
      onBlur={() => setText(null)}
      className={`field font-mono ${className}`}
    />
  );
}
