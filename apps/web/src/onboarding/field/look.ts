// On a local stack only (`vp run dev`): which dither Stephen's field is
// drawn in, so the person can try the three new ones (A, B, C) on the real
// setup and interview beside the current one, with the pointer's effect on
// or off. Set by the menu in the header (dither-picker.tsx) or by the
// address, `?dither=a|b|c|current&cursor=on|off`, and kept in this browser
// so it stays while the setup moves from screen to screen. A build for
// anywhere else always draws the current one: Vite leaves the rest out.

/** The field's dithers: the current one, and the three to try. */
export const ditherVariants = ["current", "a", "b", "c"] as const;
export type DitherVariant = (typeof ditherVariants)[number];

/** What each is, in a developer's words (not in the catalogs). */
export const ditherNames: Record<DitherVariant, string> = {
  current: "Current: silk light",
  a: "A · Dots: a halftone grid that swells",
  b: "B · Sand: grains on a singing plate",
  c: "C · Aurora: curtains of light",
};

export interface DitherLook {
  variant: DitherVariant;
  /** Whether the pointer moves the dither. */
  cursor: boolean;
}

const fallback: DitherLook = { variant: "current", cursor: true };

const KEY = "grasp.dev.dither";

const isVariant = (value: unknown): value is DitherVariant =>
  ditherVariants.some((variant) => variant === value);

const keep = (look: DitherLook) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(look));
  } catch {
    // Not kept: it holds for this visit.
  }
};

/** The look kept in this browser, then the address on top of it. */
const readLook = (): DitherLook => {
  if (!import.meta.env.DEV) {
    return fallback;
  }
  let look = fallback;
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (typeof kept === "object" && kept !== null) {
      const variant = "variant" in kept ? kept.variant : undefined;
      const cursor = "cursor" in kept ? kept.cursor : undefined;
      look = {
        variant: isVariant(variant) ? variant : fallback.variant,
        cursor: typeof cursor === "boolean" ? cursor : fallback.cursor,
      };
    }
  } catch {
    // Nothing kept.
  }
  const asked = new URL(window.location.href).searchParams;
  const variant = asked.get("dither");
  const cursor = asked.get("cursor");
  if (isVariant(variant) || cursor === "on" || cursor === "off") {
    look = {
      variant: isVariant(variant) ? variant : look.variant,
      cursor: cursor === null ? look.cursor : cursor === "on",
    };
    keep(look);
  }
  return look;
};

let look = readLook();
const listeners = new Set<() => void>();

export const ditherLookNow = (): DitherLook => look;

/** Another dither, or the pointer's effect on or off: kept, and the field redrawn. */
export const setDitherLook = (next: Partial<DitherLook>) => {
  if (!import.meta.env.DEV) {
    return;
  }
  look = { ...look, ...next };
  keep(look);
  // The address follows, so a link copied from it opens the same look.
  const url = new URL(window.location.href);
  url.searchParams.set("dither", look.variant);
  url.searchParams.set("cursor", look.cursor ? "on" : "off");
  window.history.replaceState(window.history.state, "", url);
  for (const listener of listeners) {
    listener();
  }
};

export const onDitherLook = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
