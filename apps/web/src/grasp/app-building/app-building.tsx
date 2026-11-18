// AppBuilding: what an app shows the first time it is built, before there is anything to show.
// Named cursors put a generic interface together piece by piece (a top bar, a sidebar, cards, a
// chart, a table), swap two pieces, clear it softly and build another, in an order mixed from a
// seed, so it can run for minutes without plainly repeating. When the app is ready it hands over:
// the cursors leave, the stage crosses out and the app stands in its place. Grasp's own: Palermo
// has no such part.
//
//   <AppBuilding step="Laying out the pages" />                 while the first build runs
//   <AppBuilding done={ready}><App /></AppBuilding>             hands over to the app when ready
//   <AppBuilding look="blueprint" cursors={{ layout: "Plan" }} />
//
// It fills its container: the box round it decides its size. It runs only while it is on screen in
// a shown tab, moves only transform and opacity, each move 300ms at most, and with reduced motion
// shows the finished interface, still. The drawing is decorative; the step line is said politely.
// Every value is a token (src/tokens). A caller may set layout only (`layout`).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { AnimationEvent, ReactNode } from "react";

import type { LayoutStyle } from "../layout/layout";
import { useWords, withGiven } from "../words/words";
import { cursorNames } from "./labels";
import type { AppBuildingCursors } from "./labels";
import type { AppBuildingLook } from "./parts";
import { advance, planOf, startAt, stillOf } from "./plan";
import { Scene } from "./scene";
import { looks, styles } from "./styles";
import { appBuildingWords } from "./words";

/** What a caller may style: its size and where it sits. Never its look. */
export type AppBuildingLayoutStyle = LayoutStyle;

/** Every prop an AppBuilding takes. */
export interface AppBuildingProps {
  /**
   * How it is drawn: `blocks`, soft blocks with a dither; `parts`, small parts on the system's own
   * surfaces; `blueprint`, one cursor drawing outlines on a grid.
   * @default "blocks"
   */
  variant?: AppBuildingLook;
  /** @deprecated Use `variant`. */
  look?: AppBuildingLook;
  /** What is being done now, in a line under the stage, said politely to a screen reader. */
  step?: string;
  /**
   * Its name, said to a screen reader.
   * @default "Building your app"
   */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /** The names on the cursors' tags: `layout`, `data` and `copy`. Any left out are English. */
  cursors?: Partial<AppBuildingCursors>;
  /**
   * The app is ready: the cursors leave, the stage crosses out and `children` stand in its place.
   * @default false
   */
  done?: boolean;
  /** The app itself, shown once `done`. */
  children?: ReactNode;
  /** Called once the stage has crossed out. */
  onDone?: () => void;
  /**
   * Where its order of layouts and pieces starts: two builds with one seed run alike.
   * @default 1
   */
  seed?: number;
  /** Its size and where it sits. */
  layout?: AppBuildingLayoutStyle;
}

/** The cleanup of an effect that started nothing. */
const keep = () => {
  // Nothing was started, so nothing stops.
};

/** Whether the element is on screen, in a tab that is shown: the build stops when nobody can see it. */
const useSeen = (element: HTMLElement | null) => {
  // Not seen until it is known to be: the stage a server drew, and one whose script has not come
  // alive yet (a page loads an example's code only as it nears the screen), is paused from the
  // start, so nothing runs where no one is looking.
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (element === null) {
      return keep;
    }
    const watches = typeof IntersectionObserver !== "undefined";
    // Without an observer it counts as in view; with one, not until its first report.
    let inView = !watches;
    const update = () => {
      setSeen(inView && document.visibilityState === "visible");
    };
    const observer = watches
      ? new IntersectionObserver(([entry]) => {
          inView = entry?.isIntersecting ?? true;
          update();
        })
      : null;
    observer?.observe(element);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [element]);
  return seen;
};

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
const subscribe = (change: () => void) => {
  const list = window.matchMedia(REDUCED_QUERY);
  list.addEventListener("change", change);
  return () => {
    list.removeEventListener("change", change);
  };
};
const reducedNow = () => window.matchMedia(REDUCED_QUERY).matches;
const reducedOnServer = () => false;

/** Whether the reader asked for less motion. On the server it is not known, so it moves. */
const useReducedMotion = () =>
  useSyncExternalStore(subscribe, reducedNow, reducedOnServer);

interface BuildProps {
  look: AppBuildingLook;
  seed: number;
  names: readonly string[];
  done: boolean;
  still: boolean;
}

/** The build: one step on each round of the clock, which pauses with the rest. */
const Build = ({ look, seed, names, done, still }: BuildProps) => {
  const [at, setAt] = useState(() => startAt(seed));
  const cursors = look === "blueprint" ? 1 : names.length;
  if (still) {
    const { shown, hands } = stillOf(seed, cursors);
    return (
      <Scene
        look={look}
        shown={shown}
        hands={hands}
        names={names}
        still
        round={0}
        step={0}
        done={done}
      />
    );
  }
  const { shown, hands } = planOf(at, seed, cursors);
  const next = () => {
    setAt((now) => advance(now, seed));
  };
  return (
    <>
      <Scene
        look={look}
        shown={shown}
        hands={hands}
        names={names}
        still={false}
        round={at.round}
        step={at.step}
        done={done}
      />
      {done ? null : (
        <span
          data-slot="app-building-clock"
          onAnimationIteration={next}
          {...stylex.props(styles.clock)}
        />
      )}
    </>
  );
};

/** Named cursors building a generic interface, until the app is ready and takes its place. */
/**
 * The hand-over. `gone` says the stage has left and the app stands alone: once the crossing has
 * ended, or at once when there is no crossing to wait for (`direct`). Nothing here waits on an
 * animation's end that may never come. `onDone` is told once for each time it is done.
 */
const useCrossing = (
  done: boolean,
  direct: boolean,
  onDone: (() => void) | undefined
) => {
  // Crossed: the stage has gone. Already done on the first render, it never shows.
  const [crossed, setCrossed] = useState(done);
  if (crossed && !done) {
    setCrossed(false);
  }
  const told = useRef(done);
  const tell = useEffectEvent(() => {
    if (told.current) {
      return;
    }
    told.current = true;
    onDone?.();
  });
  useEffect(() => {
    if (!done) {
      told.current = false;
    } else if (direct) {
      tell();
    }
  }, [done, direct]);
  const ended = (event: AnimationEvent<HTMLDivElement>) => {
    if (!done || event.target !== event.currentTarget) {
      return;
    }
    setCrossed(true);
    if (!told.current) {
      told.current = true;
      onDone?.();
    }
  };
  return { gone: crossed || direct, direct, ended };
};

const isFilled = (text: string | undefined) =>
  text !== undefined && text !== "";

export const AppBuilding = ({
  look: lookDeprecated,
  variant: look = lookDeprecated ?? "blocks",
  step,
  label: labelDeprecated,
  "aria-label": labelGiven,
  cursors,
  done = false,
  children,
  onDone,
  seed = 1,
  layout,
}: AppBuildingProps) => {
  // Its words: the product's, by its catalogue, else English; the caller's `aria-label` and
  // `cursors` still win.
  const words = withGiven(useWords("appBuilding", appBuildingWords), {
    ...cursors,
    name: labelGiven ?? labelDeprecated,
  });
  const { name: label } = words;
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const seen = useSeen(root);
  const still = useReducedMotion();
  // With reduced motion, or while the stage is not seen (off screen, a hidden tab: its animations
  // are paused), there is no crossing to wait for: the app shows directly.
  const { gone, direct, ended } = useCrossing(
    done,
    done && (still || !seen),
    onDone
  );
  const hasStep = isFilled(step);
  return (
    <section
      ref={setRoot}
      aria-label={label}
      aria-busy={done ? undefined : true}
      data-slot="app-building"
      data-look={look}
      data-state={done ? "done" : "building"}
      {...stylex.props(styles.root, layout)}
    >
      {gone ? null : (
        <div
          data-slot="app-building-stage"
          data-paused={seen ? undefined : ""}
          onAnimationEnd={ended}
          {...stylex.props(
            styles.stage,
            !seen && styles.paused,
            done && styles.crossing
          )}
        >
          <div
            aria-hidden="true"
            data-slot="app-building-canvas"
            {...stylex.props(styles.canvas, looks[look].ground)}
          >
            <Build
              look={look}
              seed={seed}
              names={cursorNames(words)}
              done={done}
              still={still}
            />
          </div>
          <p
            aria-live="polite"
            data-slot="app-building-step"
            {...stylex.props(styles.step, !hasStep && styles.stepEmpty)}
          >
            {hasStep && !done ? step : null}
          </p>
        </div>
      )}
      {gone ? (
        <div
          data-slot="app-building-app"
          {...(direct
            ? stylex.props(styles.app)
            : stylex.props(styles.app, styles.arriving))}
        >
          {children}
        </div>
      ) : null}
    </section>
  );
};
