import { useSyncExternalStore } from "react";

import type { BrainDots } from "../brain/dot-ink.ts";

// Which phase the way into the platform is in (platform-reveal.tsx), apart
// from the layer that plays it: every page's root reads it, and loads that
// layer only once the platform is being built.

export type RevealPhase = "idle" | "filling" | "clearing" | "building";

export interface Reveal {
  phase: RevealPhase;
  /** The brain's dots as they were handed over. */
  from: BrainDots | null;
}

let state: Reveal = { phase: "idle", from: null };
const listeners = new Set<() => void>();

export const currentReveal = (): Reveal => state;

export const setReveal = (next: Reveal): void => {
  state = next;
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useReveal = (): Reveal =>
  useSyncExternalStore(subscribe, currentReveal, currentReveal);
