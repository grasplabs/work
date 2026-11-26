import { media } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";

import { AgentFigure } from "../agents/figure/agent-figure.tsx";
import type { FigureState } from "../agents/figure/body.ts";
import type { AgentFigureLook } from "../agents/figure/look.ts";
import { liveLevels, useLoop } from "./loop.ts";

// Stephen on the stage while they talk: his orb, the one the agents' pages
// draw (agents/figure), large, in the middle where his question stood, and
// without the eye (the owner's asks, 2026-11-26). It lives with the
// conversation: it listens while they talk, a thought goes round it while
// he thinks, it breathes while nobody speaks, and while he speaks it moves
// with his voice, swelling and leaning on each word, as loud as the
// session plays it (or, for a line said outside the session, at the pace
// of speech). Their voice moves it too, less. Paused, it sleeps. Motion
// and size only, eased: no glow. With reduced motion it keeps still.

/** His orb: Stephen's own, in evergreen, without the eye. */
const orbLook: AgentFigureLook = { shape: "orb", palette: "evergreen" };

/** How much larger a voice makes him at its loudest: his own, and theirs. */
const swell = { his: 0.16, theirs: 0.05 } as const;
/** How far he leans with his voice, in degrees, and rises with it, in percent of his size. */
const lean = { degrees: 2.5, rise: 1.6 } as const;
/** How quickly he follows a voice, per frame: rising quickly, falling back slower. */
const follow = { up: 0.35, down: 0.12 } as const;
/** His breath while nobody speaks: how much, and how long one takes, in ms. */
const breath = { size: 0.018, ms: 4200 } as const;

const styles = stylex.create({
  orb: {
    display: "grid",
    placeItems: "center",
    transformOrigin: "50% 60%",
    willChange: { default: "transform", [media.reducedMotion]: null },
  },
});

/** The cleanup of an effect that started nothing. */
const still = (): void => {
  // Nothing moves: nothing to stop.
};

type Doing = ReturnType<typeof useLoop>["doing"];

/** The pose his orb takes while the conversation is doing `doing`; asleep while paused. */
const poseOf = (doing: Doing, asleep: boolean): FigureState => {
  if (asleep) {
    return "asleep";
  }
  if (doing === "listening") {
    return "listening";
  }
  if (doing === "thinking") {
    return "thinking";
  }
  return "idle";
};

/**
 * How loud he is now, 0 to 1: as the session plays him, or, for a line
 * said outside one, a voice's rise and fall at the pace of speech.
 */
const hisLevel = (heard: number, speaking: boolean, at: number): number => {
  if (!speaking) {
    return 0;
  }
  if (heard > 0.01) {
    return Math.min(1, heard * 1.6);
  }
  // Syllables, about five a second, in phrases that rise and fall.
  const syllable = Math.abs(Math.sin(at / 100));
  const phrase = 0.55 + 0.45 * Math.sin(at / 900);
  return 0.25 + 0.55 * syllable * phrase;
};

/** His orb in the middle of the stage, alive to the conversation; `asleep` while paused. */
export const StephenOrb = ({ asleep = false }: { asleep?: boolean }) => {
  const loop = useLoop();
  const box = useRef<HTMLDivElement>(null);
  const { doing } = loop;
  useEffect(() => {
    const element = box.current;
    if (
      element === null ||
      asleep ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return still;
    }
    let loud = 0;
    let frame = 0;
    const step = (at: number): void => {
      const levels = liveLevels();
      const his = hisLevel(levels.his, doing === "speaking", at);
      const theirs =
        doing === "listening" ? Math.min(1, levels.theirs * 1.6) : 0;
      const target = his * swell.his + theirs * swell.theirs;
      loud += (target - loud) * (target > loud ? follow.up : follow.down);
      const breathing =
        breath.size * Math.sin((at / breath.ms) * Math.PI * 2) * (1 - his);
      const size = 1 + loud + breathing;
      // He leans a little with what he says, the way a speaker moves: never while quiet.
      const tilt = Math.sin(at / 640) * lean.degrees * Math.min(1, his * 1.5);
      const rise = -loud * lean.rise * 10;
      element.style.transform = `translateY(${rise.toFixed(2)}%) rotate(${tilt.toFixed(2)}deg) scale(${size.toFixed(4)})`;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      element.style.transform = "";
    };
  }, [doing, asleep]);
  return (
    <div ref={box} {...stylex.props(styles.orb)}>
      <AgentFigure
        follow={false}
        look={orbLook}
        size="hero"
        state={poseOf(doing, asleep)}
      />
    </div>
  );
};
