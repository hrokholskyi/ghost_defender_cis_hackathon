"use client";

import { useEffect, useRef, useState } from "react";
import { money } from "@/lib/ui/format";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Counts from the previous value to the new one with an ease-out (instant with reduced motion). */
export function useTween(target: number, durationMs = 700): number {
  const [shown, setShown] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    const from = fromRef.current;
    if (from === target) return;
    if (prefersReducedMotion()) {
      fromRef.current = target;
      const raf = requestAnimationFrame(() => setShown(target));
      return () => cancelAnimationFrame(raf);
    }
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / durationMs);
      const e = 1 - Math.pow(1 - k, 3);
      const value = Math.round(from + (target - from) * e);
      fromRef.current = value;
      setShown(value);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return shown;
}

/** Money amount that counts to a new value and flashes when it changes. */
export function Money({ value, className }: { value: number; className?: string }) {
  const shown = useTween(value, 900);
  const [flashKey, setFlashKey] = useState(0);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    const raf = requestAnimationFrame(() => setFlashKey((k) => k + 1));
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <div key={flashKey} className={`${className ?? ""}${flashKey > 0 ? " is-changed" : ""}`}>
      {money(shown)}
    </div>
  );
}
