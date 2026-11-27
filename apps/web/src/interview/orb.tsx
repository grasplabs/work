import * as stylex from "@stylexjs/stylex";
import { useEffect } from "react";

import { AgentFigure } from "../agents/figure/agent-figure.tsx";
import type { FigureState } from "../agents/figure/body.ts";
import type { AgentFigureLook } from "../agents/figure/look.ts";
import { liveLevels, useLoop } from "./loop.ts";
import { voiceLevel } from "./speech.ts";

// Stephen on the stage while they talk: his orb, the one the agents' pages
// draw (agents/figure), large, in the middle where his question stood, and
// without the eye (the owner's asks, 2026-11-26). It is alive as the
// agents' Stephen is, never a bubble that swells (the owner's ask,
// 2026-11-27): its surface turns, slowly while nobody speaks, quicker as
// he listens; a thought goes round it while he thinks; while he speaks
// the light comes round to you and brightens with his voice, and the
// turning speeds up with it. Their voice lights it a little. Each pose is
// eased into, and sleep slowest: paused, the turning runs down and the
// colour drains to grey where it stands, and comes back the same way. Its
// size never changes. With reduced motion, one still picture of the pose.

/** His orb: Stephen's own, in evergreen, without the eye. */
const orbLook: AgentFigureLook = { shape: "orb", palette: "evergreen" };

/** How much a voice lights him at its loudest: his own, and theirs. */
const lights = { his: 1, theirs: 0.3 } as const;

const styles = stylex.create({
  orb: { display: "grid", placeItems: "center" },
});

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
  if (doing === "speaking") {
    return "speaking";
  }
  return "idle";
};

/**
 * How loud he is now, 0 to 1: as the session plays him, or, for a line
 * said outside one, a voice's rise and fall at the pace of speech.
 */
const hisLevel = (heard: number, at: number): number => {
  if (heard > 0.01) {
    return Math.min(1, heard * 2.2);
  }
  // Syllables, about five a second, in phrases that rise and fall, with a breath now and then.
  const syllable = Math.abs(Math.sin(at / 100)) ** 0.6;
  const phrase = 0.5 + 0.5 * Math.sin(at / 900);
  const breath = Math.sin(at / 2300) > 0.85 ? 0.3 : 1;
  return (0.25 + 0.75 * syllable * phrase) * breath;
};

/** What the orb on the stage shows now: the one orb there is, read by its figure every frame. */
const shown: { doing: Doing; asleep: boolean } = {
  doing: "idle",
  asleep: false,
};

/** How loud the voice his orb follows is now, 0 to 1: his while he speaks, a little of theirs while he listens. */
const voiceNow = (): number => {
  if (shown.asleep) {
    return 0;
  }
  const levels = liveLevels();
  if (shown.doing === "speaking") {
    // In the session, or a line said outside one (the guide), as it is heard.
    const heard = Math.max(levels.his, voiceLevel());
    return hisLevel(heard, performance.now()) * lights.his;
  }
  if (shown.doing === "listening") {
    return Math.min(1, levels.theirs * 1.6) * lights.theirs;
  }
  return 0;
};

/**
 * His orb in the middle of the stage, alive to the conversation; `asleep`
 * while paused. `doing`, where it isn't the conversation's (the guide
 * before it), is what he does there.
 */
export const StephenOrb = ({
  asleep = false,
  doing: own,
}: {
  asleep?: boolean;
  doing?: Doing;
}) => {
  const loop = useLoop();
  const doing = own ?? loop.doing;
  useEffect(() => {
    shown.doing = doing;
    shown.asleep = asleep;
  }, [doing, asleep]);
  return (
    <div {...stylex.props(styles.orb)}>
      <AgentFigure
        alive
        follow={false}
        look={orbLook}
        size="hero"
        state={poseOf(doing, asleep)}
        voiceOf={voiceNow}
      />
    </div>
  );
};
