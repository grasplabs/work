import type { Interviewer } from "@grasp-os/shared/onboarding";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { DotBrain } from "../brain/dot-brain.tsx";
import { DotSign } from "./dot-sign.tsx";
import type { DotSign as Sign } from "./dot-signs.ts";

// Stephen as an interview draws him (prototype `interview-parts.tsx`): the
// head that listens, in dots, as large as the window leaves him, with the
// small sign beside him of what he is doing. Claire, when she holds the
// interview, is drawn the same way from her own portrait.

/**
 * How large he is at most, by what he does: really big while he talks,
 * smaller over what he reads back; the smallest he gets before he makes
 * way, and the steps he gives way in.
 */
export const headSizes = { talking: 720, reading: 240, least: 120, step: 20 };

/** The margin he keeps at each side, in pixels. */
const margin = 16;
/** Between him and what is under him. */
const gapUnder = 24;

/**
 * Stephen and Claire side by side, to choose from: the gap between them,
 * how full the one is printed who waits while the other speaks, and how
 * much of the drifting faintness is taken away, so both can be looked at.
 */
export const pair = { gap: 16, waiting: 0.6, clear: 0.85 };

/** His sizes by twenty pixels: a class each, as a class is never built from a number. */
const sizeClasses: Record<number, string> = {
  120: "size-30",
  140: "size-35",
  160: "size-40",
  180: "size-45",
  200: "size-50",
  220: "size-55",
  240: "size-60",
  260: "size-65",
  280: "size-70",
  300: "size-75",
  320: "size-80",
  340: "size-85",
  360: "size-90",
  380: "size-95",
  400: "size-100",
  420: "size-105",
  440: "size-110",
  460: "size-115",
  480: "size-120",
  500: "size-125",
  520: "size-130",
  540: "size-135",
  560: "size-140",
  580: "size-145",
  600: "size-150",
  620: "size-155",
  640: "size-160",
  660: "size-165",
  680: "size-170",
  700: "size-175",
  720: "size-180",
};

const onResize = (listener: () => void): (() => void) => {
  window.addEventListener("resize", listener);
  return () => {
    window.removeEventListener("resize", listener);
  };
};

/** Tells `onHeight` how high `element` is, now and whenever it changes, until stopped. */
const watchHeight = (
  element: HTMLElement,
  onHeight: (height: number) => void
): (() => void) => {
  onHeight(element.offsetHeight);
  const observer = new ResizeObserver(() => {
    onHeight(element.offsetHeight);
  });
  observer.observe(element);
  return () => {
    observer.disconnect();
  };
};

/**
 * How large he can be over what stands under him, so both fit in `room`:
 * `most` when the window is that large, smaller in steps when it is lower
 * or narrower, and gone when even the smallest doesn't fit. What stands
 * under him is measured before the first paint, so he never shrinks into
 * his size on screen. With `two`, it is the size of each of two side by
 * side.
 */
export const useHead = (room: number, most: number, two = false) => {
  const body = useRef<HTMLDivElement>(null);
  const [under, setUnder] = useState(0);
  useLayoutEffect(() => {
    const element = body.current;
    return element === null ? undefined : watchHeight(element, setUnder);
  }, []);
  const width = useSyncExternalStore(onResize, () => window.innerWidth);
  const high = room - under - gapUnder;
  const wide = two ? (width - 2 * margin - pair.gap) / 2 : width - 2 * margin;
  const fits = Math.min(most, high, wide);
  const size =
    under === 0 ? 0 : Math.floor(fits / headSizes.step) * headSizes.step;
  return { body, size: size < headSizes.least ? 0 : size };
};

/**
 * Whoever holds the interview: their dotted head, as full as the interview
 * is far, with the sign beside it. Nothing of them when there is no room.
 * Stephen and Claire are two people, so the one never flows out of the
 * other: shown `beside` each other, each is a figure of their own from the
 * first frame, nearly all of it showing, their mouth warm only while they
 * are the one `speaking`.
 */
export const Head = ({
  who = "stephen",
  size,
  fill,
  label,
  sign = null,
  beside,
  voice,
}: {
  who?: Interviewer;
  size: number;
  fill: number;
  label: string;
  sign?: Sign | null;
  beside?: { speaking: boolean };
  /** How loud their voice is right now, 0 to 1. */
  voice?: () => number;
}) => {
  const shown = sizeClasses[Math.min(size, headSizes.talking)];
  if (shown === undefined) {
    return <span className="sr-only">{label}</span>;
  }
  return (
    <div
      className={cn("relative flex-none transition-all duration-500", shown)}
    >
      <DotBrain
        apart={beside === undefined ? undefined : { leaves: false }}
        className="size-full"
        label={label}
        scene={{
          shape: { kind: "listen", who },
          fill,
          ...(beside === undefined
            ? {}
            : { quiet: !beside.speaking, clear: pair.clear }),
        }}
        voice={voice}
      />
      <DotSign fill={fill} sign={sign} />
    </div>
  );
};
