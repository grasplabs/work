import { interviewerNames } from "@grasp-os/shared/onboarding";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Button } from "../grasp/button/index.ts";
import { Mic, MicOff } from "../grasp/icons/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { voice } from "./interview.stylex.ts";
import { useInterviewer } from "./kept.ts";
import { micLevel, muteMic, useMicMuted } from "./mic.ts";
import { voiceLevel } from "./speech.ts";
import { VoiceWave } from "./voice-wave.tsx";

// Talking, as a bar (prototype `voice-bar.tsx`): what is happening in
// words on the left, and through the middle the sound as a wave of dots,
// in ink with the interviewer's voice, warm and as loud as the person
// talks. Never an icon for it. At its right end stands what it is given:
// in the interview, the way to type instead. With `mute`, the dot is
// their own microphone: a press mutes them for a moment, the next brings
// them back. Muted, the bar says so in place of "Listening" and the wave
// lies still, so nobody talks to a microphone that is off. It is the same
// bar in the check before the interview, so what they see there is what
// they get.

const pulse = stylex.keyframes({
  "0%": { opacity: 1 },
  "50%": { opacity: 0.4 },
  "100%": { opacity: 1 },
});

const styles = stylex.create({
  bar: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    boxSizing: "border-box",
    width: "100%",
    height: "3.5rem",
    paddingInlineStart: grasp.space4,
    paddingInlineEnd: grasp.space4,
  },
  // On its own, in the sound check, it is drawn as a field; in the box, the box's card is its edge.
  framed: {
    borderWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: grasp.line,
    borderRadius: grasp.composerCorner,
    cornerShape: grasp.cornerShape,
  },
  withEnd: { paddingInlineEnd: grasp.space2 },
  state: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space2,
    color: grasp.muted,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  mute: { marginInlineStart: `calc(-1 * ${grasp.space2})` },
  dot: {
    width: "0.5rem",
    height: "0.5rem",
    borderRadius: grasp.cornerCircle,
    backgroundColor: grasp.line,
    transitionProperty: "background-color",
    transitionDuration: grasp.durationUi,
    transitionTimingFunction: grasp.ease,
  },
  hearing: {
    backgroundColor: voice.heat,
    animationName: { default: pulse, [media.reduced]: "none" },
    animationDuration: "2s",
    animationIterationCount: "infinite",
  },
  wave: { flexGrow: 1, minWidth: 0, height: "2.5rem" },
});

/** What the bar shows: the microphone being asked for, them talking, the interviewer talking, or a moment while he thinks. */
export type BarDoing = "asking" | "listening" | "speaking" | "thinking";

/** Their own microphone, as the bar's dot: pressed, it mutes them, or brings them back. */
const MuteButton = () => {
  const { t } = useLingui();
  const muted = useMicMuted();
  const label = muted
    ? t({ message: "Unmute", context: "turn your microphone back on" })
    : t({ message: "Mute", context: "turn your microphone off for a moment" });
  return (
    <Button
      aria-label={label}
      aria-pressed={muted}
      icon={muted ? MicOff : Mic}
      layout={styles.mute}
      onClick={() => {
        muteMic(!muted);
      }}
      size="sm"
      title={label}
      variant={muted ? "quiet" : "ghost"}
    />
  );
};

export const VoiceBar = ({
  doing,
  mute = false,
  framed = false,
  children,
}: {
  doing: BarDoing;
  /** Whether they can mute themselves from the bar. */
  mute?: boolean;
  /** Drawn as a field of its own, where no box holds it. */
  framed?: boolean;
  children?: ReactNode;
}) => {
  const { t } = useLingui();
  const who = interviewerNames[useInterviewer()];
  const muted = useMicMuted();
  const listening = doing === "listening" && !muted;
  let label = t`One moment`;
  if (listening) {
    label = t`Listening`;
  } else if (doing === "speaking") {
    label = t`${who} is talking`;
  } else if (doing === "listening") {
    label = t({
      message: "Muted",
      context: "your microphone is off for a moment",
    });
  }
  let of: "person" | "interviewer" | "quiet" = "quiet";
  if (listening) {
    of = "person";
  } else if (doing === "speaking") {
    of = "interviewer";
  }
  return (
    <div
      {...stylex.props(
        styles.bar,
        framed && styles.framed,
        children !== undefined && styles.withEnd
      )}
    >
      <span aria-live="polite" {...stylex.props(styles.state)}>
        {mute ? (
          <MuteButton />
        ) : (
          <span
            aria-hidden="true"
            {...stylex.props(styles.dot, listening && styles.hearing)}
          />
        )}
        {label}
      </span>
      <div {...stylex.props(styles.wave)}>
        <VoiceWave level={listening ? micLevel : voiceLevel} of={of} />
      </div>
      {children}
    </div>
  );
};
