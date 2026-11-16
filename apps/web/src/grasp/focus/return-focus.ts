// Return focus: a layer opened by a prop, with no trigger of its own, gives focus back to what
// had it. UI SDK does this while the layer's panel stays in the tree; it cannot when the panel is
// drawn only while there is something to ask (`{asking && <AlertDialogPanel>}`), because the panel
// then leaves the page in the same draw that closes it, and focus falls to the page.
//
//   useReturnFocus(open)      in a layer's root, with its `open` prop
//
// One listener for the whole page notes, for each layer, what had focus as focus first went into
// it. When a layer's `open` turns false and focus is on the page or still inside a layer that is
// going, focus goes back to that element. If it has left the page meanwhile (a row's Delete that
// removed its row), focus goes to the nearest stop that shared a container with it, never to the
// page. A layer that has a trigger is left to UI SDK, which returns focus to the trigger.
"use client";

import { useEffect, useRef } from "react";

const LAYER = '[role="dialog"], [role="alertdialog"]';

/** What can take focus by Tab. */
const STOP =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Entered {
  /** The layer focus went into. */
  layer: Element;
  /** What had focus before. */
  from: HTMLElement;
  /** What holds it, from its parent outwards: where to look if it is gone when the layer closes. */
  homes: Element[];
  /** The stops beside it, the next ones first, then the ones before, nearest first. */
  near: HTMLElement[];
}

const homesOf = (from: Element) => {
  const homes: Element[] = [];
  for (
    let parent = from.parentElement;
    parent !== null;
    parent = parent.parentElement
  ) {
    homes.push(parent);
  }
  return homes;
};

const nearOf = (from: HTMLElement, layer: Element) => {
  const stops = [...document.querySelectorAll<HTMLElement>(STOP)].filter(
    (each) => !layer.contains(each)
  );
  const at = stops.indexOf(from);
  return at === -1
    ? []
    : [
        ...stops.slice(at + 1, at + 4),
        ...stops.slice(Math.max(0, at - 3), at).toReversed(),
      ];
};

/**
 * Where focus goes back to: what had it, or, when that has left the page (a row's Delete that
 * removed its row), the nearest stop that shared a container with it: the next row's, else the one
 * before; else the first stop in what is left of that container.
 */
const placeFor = ({ from, homes, near }: Entered) => {
  if (from.isConnected) {
    return from;
  }
  const home = homes.find((each) => each.isConnected);
  const kept = near.filter(
    (each) => each.isConnected && each.getClientRects().length > 0
  );
  return (
    kept.find((each) => home?.contains(each) === true) ??
    home?.querySelector<HTMLElement>(STOP) ??
    kept[0]
  );
};

// Layers open and close last in, first out, so this is a stack: the newest is the one closing.
const watch: { on: boolean; entered: Entered[] } = { on: false, entered: [] };

const note = (event: FocusEvent) => {
  const { target, relatedTarget } = event;
  if (!(target instanceof Element)) {
    return;
  }
  const layer = target.closest(LAYER);
  if (layer === null) {
    // Focus is outside every layer: none is open, so nothing is owed.
    watch.entered = [];
    return;
  }
  const known = watch.entered.some((each) => each.layer === layer);
  // Only the first time focus goes into a layer: later moves inside it, or back from a layer
  // above it, are not where it came from.
  if (
    !known &&
    relatedTarget instanceof HTMLElement &&
    !layer.contains(relatedTarget)
  ) {
    watch.entered = [
      ...watch.entered.filter((each) => each.layer.isConnected),
      {
        layer,
        from: relatedTarget,
        homes: homesOf(relatedTarget),
        near: nearOf(relatedTarget, layer),
      },
    ];
  }
};

const start = () => {
  if (!watch.on) {
    watch.on = true;
    document.addEventListener("focusin", note, true);
  }
};

/** Gives focus back to what had it before the newest layer took it, if focus has nowhere to be. */
const giveBack = () => {
  const last = watch.entered.at(-1);
  if (last === undefined) {
    return;
  }
  watch.entered = watch.entered.slice(0, -1);
  const active = document.activeElement;
  const adrift =
    active === null ||
    active === document.body ||
    last.layer.contains(active) ||
    !active.isConnected;
  if (adrift) {
    placeFor(last)?.focus({ preventScroll: true });
  }
};

/**
 * In a layer's root: when `open` is a prop and turns false, or the layer leaves the page while still
 * open, focus goes back to what had it when the layer opened. Does nothing for a layer that opens itself (no `open` prop): its trigger gets focus
 * back from UI SDK.
 */
export const useReturnFocus = (open: boolean | undefined) => {
  const was = useRef(false);
  useEffect(() => {
    start();
    // A layer drawn only while it is open (`{asking && <Sheet open>}`) never sees `open` turn
    // false: it leaves the page still open. Focus goes back then too.
    return () => {
      if (was.current) {
        giveBack();
      }
    };
  }, []);
  useEffect(() => {
    if (was.current && open === false) {
      giveBack();
    }
    was.current = open === true;
  }, [open]);
};
