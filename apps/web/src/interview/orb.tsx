import { media } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";

import { AgentFigure } from "../agents/figure/agent-figure.tsx";
import type { FigureState } from "../agents/figure/body.ts";
import { stephensLook } from "../agents/figure/look.ts";
import { liveLevels, useLoop } from "./loop.ts";

// Stephen on the stage while they talk: his orb, the one the agents' pages
// draw (agents/figure), in the middle where his question stood (the
// owner's ask, 2026-11-26). It takes the conversation's pose: listening
// while they talk, a thought going round it while he thinks, at rest while
// he speaks, and it swells a little with his voice and, less, with theirs,
// as loud as the session hears each. Barely: a few percent, eased, never a
// glow. With reduced motion it keeps its size. What was said is in the
// transcript beside it.

/** How much larger his voice makes him at its loudest, and theirs. */
const swell = { his: 0.06, theirs: 0.025 } as const;
/** How quickly the size follows the voice, per frame: lower is calmer. */
const follow = 0.18;

const styles = stylex.create({
  orb: {
    display: "grid",
    placeItems: "center",
    transformOrigin: "50% 50%",
    willChange: { default: "transform", [media.reducedMotion]: null },
  },
});

/** The cleanup of an effect that started nothing. */
const still = (): void => {
  // Nothing moves: nothing to stop.
};

/** The pose his orb takes while the conversation is doing `doing`. */
const poseOf = (doing: ReturnType<typeof useLoop>["doing"]): FigureState => {
  if (doing === "listening") {
    return "listening";
  }
  if (doing === "thinking") {
    return "thinking";
  }
  return "idle";
};

/** His orb in the middle of the stage, alive to the conversation. */
export const StephenOrb = () => {
  const loop = useLoop();
  const box = useRef<HTMLDivElement>(null);
  const { doing } = loop;
  useEffect(() => {
    const element = box.current;
    if (
      element === null ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return still;
    }
    let size = 1;
    let frame = 0;
    const step = (): void => {
      const { his, theirs } = liveLevels();
      const loud =
        doing === "speaking"
          ? Math.min(1, his) * swell.his
          : Math.min(1, theirs) * swell.theirs;
      size += (1 + loud - size) * follow;
      element.style.transform = `scale(${size.toFixed(4)})`;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      element.style.transform = "";
    };
  }, [doing]);
  return (
    <div ref={box} {...stylex.props(styles.orb)}>
      <AgentFigure look={stephensLook} size="xl" state={poseOf(doing)} />
    </div>
  );
};
