"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * Yol tarifi için adres kutusu: yazarken Google Places önerileri
 * (`POST /api/map/places`), Google Haritalar'daki gibi.
 *
 * - 300 ms bekleyip en az 3 karakterde sorar; eski yanıtlar atılır.
 * - Yazma oturumu başına bir `sessionToken`; seçimde konum ("details") ile
 *   oturum biter ve yenisi başlar (Google o oturumun önerilerini ayrıca
 *   faturalamaz).
 * - Sunucu `provider: "none"` derse (Places kapalı, kota, hata) öneriler bu
 *   kutuda kapanır; kutu düz metin olarak çalışmaya devam eder (Enter →
 *   `onEnter`, üst bileşen Geocoding'e gider).
 * - `enabled=false` (harita OpenStreetMap'te) iken hiç istek atılmaz.
 */

export interface PickedPlace {
  label: string;
  lat: number;
  lng: number;
}

interface Suggestion {
  placeId: string;
  main: string;
  secondary: string;
}

const DEBOUNCE_MS = 300;
const MIN_CHARS = 3;

function newToken(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

export function AddressAutocomplete({
  poleId,
  enabled,
  value,
  onChange,
  onPick,
  onEnter,
  onError,
}: {
  poleId: string;
  /** Google haritasındayken true. */
  enabled: boolean;
  value: string;
  onChange: (text: string) => void;
  onPick: (place: PickedPlace) => void;
  /** Öneri seçilmeden Enter. */
  onEnter: () => void;
  onError: (message: string) => void;
}) {
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [picking, setPicking] = useState(false);
  /** Bu kutuda öneriler kapandı mı (sunucu "none" dedi). */
  const [off, setOff] = useState(false);
  const listId = useId();

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  const session = useRef<string>("");
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    [],
  );

  const canSuggest = enabled && !off;

  function post(body: Record<string, unknown>) {
    return fetch("/api/map/places", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poleId, sessionToken: session.current, ...body }),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  }

  function query(text: string) {
    if (timer.current) clearTimeout(timer.current);
    const input = text.trim();
    const my = ++seq.current;
    if (!canSuggest || input.length < MIN_CHARS) {
      setItems([]);
      setOpen(false);
      return;
    }
    timer.current = setTimeout(async () => {
      if (!session.current) session.current = newToken();
      try {
        const { json } = await post({ action: "suggest", input });
        if (my !== seq.current) return; // daha yeni bir istek var
        if (!json?.ok) return;
        if (json.data.provider !== "google") {
          setOff(true);
          setItems([]);
          setOpen(false);
          return;
        }
        const list = json.data.suggestions as Suggestion[];
        setItems(list);
        setActive(-1);
        setOpen(list.length > 0);
      } catch {
        /* ağ hatası: öneri yok, kutu çalışmaya devam eder */
      }
    }, DEBOUNCE_MS);
  }

  async function pick(s: Suggestion) {
    if (timer.current) clearTimeout(timer.current);
    seq.current++;
    setOpen(false);
    setPicking(true);
    const label = s.secondary ? `${s.main}, ${s.secondary}` : s.main;
    onChange(label);
    try {
      const { status, json } = await post({ action: "details", placeId: s.placeId });
      if (json?.ok && json.data.provider === "google") {
        onPick({ ...json.data.place, label } as PickedPlace);
      } else if (json && !json.ok) {
        onError(json.error ?? "Seçilen yerin konumu alınamadı.");
      } else {
        // Places kullanılamıyor: metinle devam (Geocoding).
        if (status === 200) setOff(true);
        onEnter();
      }
    } catch {
      onError("Seçilen yerin konumu alınamadı. Bağlantınızı kontrol edin.");
    } finally {
      // Oturum details ile bitti; sonraki yazma yeni oturum açar.
      session.current = "";
      setPicking(false);
      setItems([]);
    }
  }

  return (
    <div className="relative">
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        value={value}
        maxLength={200}
        disabled={picking}
        onChange={(e) => {
          onChange(e.target.value);
          query(e.target.value);
        }}
        onFocus={() => {
          if (items.length > 0) setOpen(true);
        }}
        onBlur={() => {
          // Listeye tıklama blur'dan sonra gelir: kısa gecikmeyle kapat.
          blurTimer.current = setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={(e) => {
          if (open && items.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => (a + 1) % items.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a <= 0 ? items.length - 1 : a - 1));
              return;
            }
            if (e.key === "Escape") {
              setOpen(false);
              return;
            }
            if (e.key === "Enter" && active >= 0) {
              e.preventDefault();
              void pick(items[active]);
              return;
            }
          }
          if (e.key === "Enter") {
            setOpen(false);
            onEnter();
          }
        }}
        placeholder="Adres ya da yer adı yazın"
        aria-label="Başlangıç adresi"
        autoComplete="off"
        className="field !h-9 !text-[13px]"
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-panel py-1 shadow-xl"
        >
          {items.map((s, i) => (
            <li
              key={s.placeId}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void pick(s)}
              onMouseEnter={() => setActive(i)}
              className={`cursor-pointer px-2.5 py-1.5 text-[12.5px] ${i === active ? "bg-panel-2" : ""}`}
            >
              <span className="block truncate text-text">{s.main}</span>
              {s.secondary ? <span className="block truncate text-[11.5px] text-muted">{s.secondary}</span> : null}
            </li>
          ))}
          <li aria-hidden className="px-2.5 pt-1 text-right text-[10.5px] text-muted">
            Google
          </li>
        </ul>
      ) : null}
    </div>
  );
}
