import { useLingui } from "@lingui/react/macro";
import { useEffect, useSyncExternalStore } from "react";

import type { BrainDots } from "./dot-ink.ts";
import { DotsBuild } from "./dots-build.tsx";

/**
 * The way from the brain into a note, as in the prototype (grasplabs/prototype, packages/grasp:
 * components/knowledge/note-reveal.tsx): the atlas goes in on the note's neuron and hands its dots
 * over here; this layer, over the part of the screen the brain and the note share, holds them
 * while the note's page opens underneath, then lets them stream out and lay the page down from
 * its top, the page opening behind them as they land. Quick: it is taken often.
 */

/** How long it takes, as a share of the way into the platform. */
const PACE = 0.6;

let handed: BrainDots | null = null;
const listeners = new Set<() => void>();

const set = (next: BrainDots | null): void => {
  handed = next;
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

/** The atlas hands its dots over, where they are on its canvas, just before the note's page opens. */
export const beginNoteReveal = (dots: BrainDots): void => {
  set(dots);
};

const endNoteReveal = (): void => {
  set(null);
};

/** The note's page shows underneath once its article is there. */
const pageOf = (layer: HTMLCanvasElement): Element =>
  layer.parentElement ?? document.body;

const pageShows = (layer: HTMLCanvasElement): boolean =>
  Boolean(layer.parentElement?.querySelector("article"));

/** The layer itself. It sits beside the brain and the note, inside what holds them, and covers exactly that. */
export const NoteReveal = () => {
  const { t } = useLingui();
  const dots = useSyncExternalStore(
    subscribe,
    () => handed,
    () => null
  );
  // Leaving the brain half way lets go of the dots.
  useEffect(() => endNoteReveal, []);
  if (!dots) {
    return null;
  }
  return (
    <DotsBuild
      className="pointer-events-none absolute inset-0 z-20 size-full"
      from={dots}
      label={t`Opening the note`}
      onEnd={endNoteReveal}
      pace={PACE}
      ready={pageShows}
      root={pageOf}
    />
  );
};
