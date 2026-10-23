import { interviewerNames } from "@grasp-os/shared/onboarding";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

import { useInterviewer } from "./kept.ts";
import { micLevel } from "./mic.ts";
import { voiceLevel } from "./speech.ts";
import { VoiceWave } from "./voice-wave.tsx";

// Talking, as a bar (prototype `voice-bar.tsx`): what is happening in
// words on the left, and through the middle the sound as a wave of dots,
// in ink with the interviewer's voice, warm and as loud as the person
// talks. Never an icon for it. At its right end stands what it is given:
// in the interview, the way to type instead. It is the same bar in the
// check before the interview, so what they see there is what they get.

/** What the bar shows: the microphone being asked for, them talking, the interviewer talking, or a moment while he thinks. */
export type BarDoing = "asking" | "listening" | "speaking" | "thinking";

export const VoiceBar = ({
  doing,
  children,
}: {
  doing: BarDoing;
  children?: ReactNode;
}) => {
  const { t } = useLingui();
  const who = interviewerNames[useInterviewer()];
  const listening = doing === "listening";
  let label = t`One moment`;
  if (listening) {
    label = t`Listening`;
  } else if (doing === "speaking") {
    label = t`${who} is talking`;
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
        <span
          aria-hidden="true"
          className={cn(
            "size-2 rounded-full transition-colors duration-300",
            listening ? "bg-brain-heat animate-pulse" : "bg-border"
          )}
        />
        {label}
      </span>
      <div className="h-10 min-w-0 flex-1">
        <VoiceWave level={listening ? micLevel : voiceLevel} of={of} />
      </div>
      {children}
    </div>
  );
};
