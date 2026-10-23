import { interviewerNames } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import { MicIcon, MicOffIcon } from "lucide-react";
import type { ReactNode } from "react";

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

/** What the bar shows: the microphone being asked for, them talking, the interviewer talking, or a moment while he thinks. */
export type BarDoing = "asking" | "listening" | "speaking" | "thinking";

/** Their own microphone, as the bar's dot: pressed, it mutes them, or brings them back. */
const MuteButton = ({ listening }: { listening: boolean }) => {
  const { t } = useLingui();
  const muted = useMicMuted();
  const label = muted
    ? t({ message: "Unmute", context: "turn your microphone back on" })
    : t({ message: "Mute", context: "turn your microphone off for a moment" });
  return (
    <Button
      aria-label={label}
      aria-pressed={muted}
      className="-ml-2"
      onClick={() => {
        muteMic(!muted);
      }}
      size="icon-sm"
      title={label}
      variant={muted ? "secondary" : "ghost"}
    >
      {muted ? (
        <MicOffIcon />
      ) : (
        <MicIcon className={cn(listening && "text-brain-heat")} />
      )}
    </Button>
  );
};

export const VoiceBar = ({
  doing,
  mute = false,
  children,
}: {
  doing: BarDoing;
  /** Whether they can mute themselves from the bar. */
  mute?: boolean;
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
      className={cn(
        "border-input flex h-14 w-full items-center gap-3 rounded-xl border pl-4",
        children === undefined ? "pr-4" : "pr-2"
      )}
    >
      <span
        aria-live="polite"
        className="text-muted-foreground flex flex-none items-center gap-2.5"
      >
        {mute ? (
          <MuteButton listening={listening} />
        ) : (
          <span
            aria-hidden="true"
            className={cn(
              "size-2 rounded-full transition-colors duration-300",
              listening ? "bg-brain-heat animate-pulse" : "bg-border"
            )}
          />
        )}
        {label}
      </span>
      <div className="h-10 min-w-0 flex-1">
        <VoiceWave level={listening ? micLevel : voiceLevel} of={of} />
      </div>
      {children}
    </div>
  );
};
