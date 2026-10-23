import type { InterviewLine } from "@grasp-os/shared/interview-links";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef } from "react";

import { Marked, Own } from "./talk.tsx";
import { useInterviewWords } from "./words.ts";

// The transcript, from the button top right (prototype
// `interview-view.tsx`, `Transcript`): the conversation as a normal chat,
// Stephen on the left and them on the right, with what he marked in their
// words. It is no panel: it floats at the right side with nothing around
// it, fades in and away, and follows the newest line. It scrolls in
// itself; the page around it never does.

export const transcriptId = "interview-transcript";

export const Transcript = ({
  open,
  alone,
  lines,
}: {
  open: boolean;
  /** The stage made way for it: it is what a screen reader hears the conversation from. */
  alone: boolean;
  lines: InterviewLine[];
}) => {
  const { t } = useLingui();
  const names = useInterviewWords().tag;
  const list = useRef<HTMLDivElement>(null);
  const count = lines.length;
  // It follows the newest line down.
  useEffect(() => {
    if (open && count > 0) {
      const element = list.current;
      if (element !== null) {
        element.scrollTop = element.scrollHeight;
      }
    }
  }, [open, count]);
  if (!open) {
    return null;
  }
  const marked = lines.some(({ marks }) => (marks?.length ?? 0) > 0);
  return (
    <aside
      aria-label={t`Transcript`}
      className="animate-in fade-in absolute inset-x-4 top-0 bottom-0 z-10 flex flex-col duration-300 sm:right-10 sm:left-auto sm:w-80"
      id={transcriptId}
    >
      {marked ? (
        <p className="text-muted-foreground flex-none pb-2 text-xs">{t`What is marked is what I wrote down. You check it at the end.`}</p>
      ) : null}
      <div
        aria-live={alone ? "polite" : "off"}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain mask-y-from-95%"
        ref={list}
      >
        <ol className="flex flex-col gap-4 py-6">
          {lines.length === 0 ? (
            <li className="text-muted-foreground">{t`Nothing said yet.`}</li>
          ) : null}
          {lines.map((line, at) => (
            <li
              className={cn(line.from === "stephen" && "pr-6")}
              // The conversation only grows: a line's place is what it is.
              key={at}
            >
              {line.from === "stephen" ? (
                <p className="text-sm leading-relaxed">
                  <span className="sr-only">Stephen: </span>
                  {line.text}
                </p>
              ) : (
                <Own>
                  <span className="sr-only">{t`You:`} </span>
                  <Marked
                    marks={line.marks ?? []}
                    names={names}
                    text={line.text}
                  />
                </Own>
              )}
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
};
