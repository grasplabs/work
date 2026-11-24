import { interviewerNames } from "@grasp-os/shared/onboarding";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { voice } from "./interview.stylex.ts";
import { useInterviewer } from "./kept.ts";
import { micLevel, useMicMuted } from "./mic.ts";
import { voiceLevel } from "./speech.ts";
import { VoiceWave } from "./voice-wave.tsx";
import type { WaveOf } from "./voice-wave.tsx";

// Talking, as a bar in the check before the interview (prototype
// `voice-bar.tsx`): what is happening in words on the left, and through the
// middle the sound as a wave of dots, in ink with the interviewer's voice,
// warm and as loud as the person talks. Never an icon for it. In the
// interview itself the box gives way to Damsko's PromptInputVoice
// (composer.tsx), which draws the voice its own way.

const pulse = stylex.keyframes({
  "0%": { opacity: 1 },
  "50%": { opacity: 0.4 },
  "100%": { opacity: 1 },
});

const styles = stylex.create({
  // A field of its own, where no box holds it.
  bar: {
    display: "flex",
    alignItems: "center",
    gap: space["3"],
    boxSizing: "border-box",
    width: "100%",
    height: "3.5rem",
    paddingInline: space["4"],
    borderWidth: size.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.promptInputRadius,
    cornerShape: radius.shape,
  },
  state: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space["2"],
    color: colors.mutedForeground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  dot: {
    width: "0.5rem",
    height: "0.5rem",
    borderRadius: radius.circle,
    backgroundColor: colors.border,
    transitionProperty: "background-color",
    transitionDuration: duration.ui,
    transitionTimingFunction: duration.ease,
  },
  hearing: {
    backgroundColor: voice.heat,
    animationName: { default: pulse, [media.reducedMotion]: "none" },
    animationDuration: "2s",
    animationIterationCount: "infinite",
  },
  wave: { flexGrow: 1, minWidth: 0, height: "2.5rem" },
});

/** What the bar shows: the microphone being asked for, them talking, or the interviewer talking. */
export type BarDoing = "asking" | "listening" | "speaking";

export const VoiceBar = ({ doing }: { doing: BarDoing }) => {
  const { t } = useLingui();
  const who = interviewerNames[useInterviewer()];
  const muted = useMicMuted();
  const listening = doing === "listening" && !muted;
  let label = t`One moment`;
  if (listening) {
    label = t`Listening`;
  } else if (doing === "speaking") {
    label = t`${who} is talking`;
  }
  let of: WaveOf = "quiet";
  if (listening) {
    of = "person";
  } else if (doing === "speaking") {
    of = "interviewer";
  }
  return (
    <div {...stylex.props(styles.bar)}>
      <span aria-live="polite" {...stylex.props(styles.state)}>
        <span
          aria-hidden="true"
          {...stylex.props(styles.dot, listening && styles.hearing)}
        />
        {label}
      </span>
      <div {...stylex.props(styles.wave)}>
        <VoiceWave level={listening ? micLevel : voiceLevel} of={of} />
      </div>
    </div>
  );
};
