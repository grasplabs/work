import type { ThinkingStep } from "@grasp-os/shared/thinking";
import { useEffect, useState } from "react";

import { readFor } from "./beats.ts";
import { later } from "./later.ts";
import { thinkingSchedule } from "./play.ts";

// The line over an answer while Grasp shows its thinking in the brain: it
// says each step as it comes, and each stays up as long as it takes to
// read, however quickly the next one arrived (grasplabs/prototype
// `components/chat/chat-message.tsx`, its working line).

/**
 * The step the line says now: the latest whose turn has come, each shown
 * when it arrived (`arrivals`) but never before the one before was read.
 * With less motion, the newest at once.
 */
export const useSteppedLine = (
  steps: readonly ThinkingStep[],
  arrivals: readonly (number | undefined)[],
  still: boolean
): ThinkingStep | undefined => {
  const [now, setNow] = useState(0);
  const [first] = arrivals;
  const began =
    first === undefined
      ? []
      : thinkingSchedule(
          first,
          steps.map(({ text }) => readFor(text.length)),
          arrivals
        );
  const due = began.find((at) => at > now);
  useEffect(
    () =>
      still || due === undefined
        ? undefined
        : later(due, () => {
            setNow(Date.now());
          }),
    [due, still]
  );
  if (still) {
    return steps.at(-1);
  }
  const shown = began.filter((at) => at <= now).length - 1;
  return shown < 0 ? undefined : steps[shown];
};
