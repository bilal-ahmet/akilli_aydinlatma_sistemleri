"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { ThemeMode } from "@/app/_lib/types";

const STORAGE_KEY = "fener-theme";

interface ThemeContextValue {
  mode: ThemeMode;
  /** Ekrana o an uygulanan gerçek tema. */
  resolved: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** "auto" modda: gün ışığı saatleri (07:00–19:59) gündüz, gerisi gece. */
function autoResolve(date = new Date()): "light" | "dark" {
  const hour = date.getHours();
  return hour >= 7 && hour < 20 ? "light" : "dark";
}

function resolveTheme(mode: ThemeMode): "light" | "dark" {
  return mode === "auto" ? autoResolve() : mode;
}

function applyTheme(resolved: "light" | "dark") {
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // SSR ve ilk render varsayılanı "auto" (inline script görseli zaten ayarladı).
  const [mode, setModeState] = useState<ThemeMode>("auto");

  // Mount'ta kayıtlı tercihi oku. setState'i bir sonraki tick'e ertele:
  // efekt gövdesinde senkron setState cascading render'a yol açar.
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
    if (stored === "light" || stored === "dark" || stored === "auto") {
      const id = window.setTimeout(() => setModeState(stored), 0);
      return () => window.clearTimeout(id);
    }
  }, []);

  // Mod değişince temayı DOM'a uygula ve kaydet (harici sistem = setState yok).
  useEffect(() => {
    applyTheme(resolveTheme(mode));
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  // "auto" modda saat ilerledikçe (ör. akşam olunca) temayı tazele.
  useEffect(() => {
    if (mode !== "auto") return;
    const id = window.setInterval(() => applyTheme(autoResolve()), 60_000);
    return () => window.clearInterval(id);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => setModeState(next), []);

  return (
    <ThemeContext.Provider value={{ mode, resolved: resolveTheme(mode), setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme, ThemeProvider içinde kullanılmalı.");
  return ctx;
}
