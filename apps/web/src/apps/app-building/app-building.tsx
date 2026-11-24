import type { LayoutStyle } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState, useSyncExternalStore } from "react";

import { advance, planOf, startAt, stillOf } from "./plan.ts";
import { Scene } from "./scene.tsx";
import { blocks, styles } from "./styles.ts";

// App building: what an App's workspace shows the first time it is built, before there is
// anything to show (app-workspace.tsx). Named cursors put a generic interface together piece by
// piece (a top bar, a sidebar, cards, a chart, a table), swap two pieces, clear it softly and
// build another, in an order mixed from a seed, so it can run for minutes without plainly
// repeating. From Damsko's cutover (grasplabs/ui 105e94c72), the blocks look alone, which is the
// one the workspace draws.
//
// It fills its container: the box round it decides its size. It runs only while it is on screen
// in a shown tab, moves only transform and opacity, each move 300ms at most, and with reduced
// motion shows the finished interface, still. The drawing is decorative; the step line is said
// politely.

/** Where its order of layouts and pieces starts: every build runs alike. */
const SEED = 1;

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

/** The build: one step on each round of the clock, which pauses with the rest. */
const Build = ({
  names,
  still,
}: {
  names: readonly string[];
  still: boolean;
}) => {
  const [at, setAt] = useState(() => startAt(SEED));
  if (still) {
    const { shown, hands } = stillOf(SEED, names.length);
    return (
      <Scene
        hands={hands}
        names={names}
        round={0}
        shown={shown}
        step={0}
        still
      />
    );
  }
  const { shown, hands } = planOf(at, SEED, names.length);
  const next = () => {
    setAt((now) => advance(now, SEED));
  };
  return (
    <>
      <Scene
        hands={hands}
        names={names}
        round={at.round}
        shown={shown}
        step={at.step}
        still={false}
      />
      <span onAnimationIteration={next} {...stylex.props(styles.clock)} />
    </>
  );
};

/** Named cursors building a generic interface; `step` says what is being done now. */
export const AppBuilding = ({
  "aria-label": label,
  step,
  style,
}: {
  /** Its name, said to a screen reader. */
  "aria-label": string;
  /** What is being done now, in a line under the stage, said politely to a screen reader. */
  step: string;
  /** Its size and where it sits. */
  style?: LayoutStyle;
}) => {
  const { t } = useLingui();
  const names = [
    t({ message: "Layout", context: "who builds an app's look" }),
    t({ message: "Data", context: "who builds an app's data" }),
    t({ message: "Words", context: "who writes an app's words" }),
  ];
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const seen = useSeen(root);
  const still = useReducedMotion();
  return (
    <section
      aria-busy
      aria-label={label}
      ref={setRoot}
      {...stylex.props(styles.root, style)}
    >
      <div {...stylex.props(styles.stage, !seen && styles.paused)}>
        <div aria-hidden="true" {...stylex.props(styles.canvas, blocks.ground)}>
          <Build names={names} still={still} />
        </div>
        <p aria-live="polite" {...stylex.props(styles.step)}>
          {step}
        </p>
      </div>
    </section>
  );
};
