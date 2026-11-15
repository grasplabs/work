import type { InterviewLine } from "@grasp-os/shared/interview-links";
import { interviewerNames } from "@grasp-os/shared/onboarding";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import { XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useInterviewer } from "./kept.ts";
import { Marked, Own } from "./talk.tsx";
import { useInterviewWords } from "./words.ts";

// The transcript, from the button top right (prototype
// `interview-view.tsx`, `Transcript`): the conversation as a normal chat,
// Stephen on the left and them on the right, with what he marked in their
// words. It is no panel: it floats at the right side with nothing around
// it, fades in and away, and follows the newest line. It scrolls in
// itself; the page around it never does. Each line can be removed, by
// them alone, once confirmed (GRA-1897): only they read what was said,
// so only they can say which words should go.

export const transcriptId = "interview-transcript";

/** How many words of a line its remove button names it by. */
const namingWords = 6;

/** The first words of `text`, to name its line by. */
const startOf = (text: string): string => {
  const words = text.trim().split(/\s+/u);
  const start = words.slice(0, namingWords).join(" ");
  return words.length > namingWords ? `${start}…` : start;
};

/** Removes a line of the transcript, once confirmed: it can't be undone. */
const RemoveLine = ({
  at,
  onRemove,
}: {
  at: number | null;
  onRemove: (at: number | null) => void;
}) => {
  const { t } = useLingui();
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) {
          onRemove(null);
        }
      }}
      open={at !== null}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Remove this line?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`The line is deleted now, and so is what I marked in it. What I wrote down from it is in what I read back to you at the end: take it out there, and it is deleted for good when our conversation is finished. This can’t be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t`Cancel`}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onRemove(at);
            }}
            variant="destructive"
          >
            {t`Remove`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/** One line, as it was said; one removed, as removed. */
const Line = ({
  line,
  names,
}: {
  line: InterviewLine;
  names: ReturnType<typeof useInterviewWords>["tag"];
}) => {
  const { t } = useLingui();
  if (line.removed === true) {
    return (
      <p className="text-muted-foreground min-w-0 flex-1 text-sm italic">
        {line.from === "stephen" ? t`A line of mine, removed.` : t`Removed.`}
      </p>
    );
  }
  return line.from === "stephen" ? (
    <p className="min-w-0 flex-1 text-sm leading-relaxed">
      <span className="sr-only">Stephen: </span>
      {line.text}
    </p>
  ) : (
    <Own className="min-w-0 flex-1">
      <span className="sr-only">{t`You:`} </span>
      <Marked marks={line.marks ?? []} names={names} text={line.text} />
    </Own>
  );
};

export const Transcript = ({
  open,
  alone,
  lines,
  onRemove,
}: {
  open: boolean;
  /** The stage made way for it: it is what a screen reader hears the conversation from. */
  alone: boolean;
  lines: InterviewLine[];
  /** Removes the line at its place, for good. */
  onRemove: (at: number) => void;
}) => {
  const { t } = useLingui();
  const [removing, setRemoving] = useState<number | null>(null);
  const who = interviewerNames[useInterviewer()];
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
          {lines.map((line, at) => {
            const words = startOf(line.text);
            return (
              <li
                className={cn(
                  "flex items-start gap-1",
                  line.from === "stephen" ? "pr-6" : "flex-row-reverse"
                )}
                // The conversation only grows: a line's place is what it is.
                key={at}
              >
                <Line line={line} names={names} />
                {line.removed === true ? null : (
                  <Button
                    aria-label={
                      line.from === "stephen"
                        ? t`Remove ${who}’s line: ${words}`
                        : t`Remove your line: ${words}`
                    }
                    className="flex-none"
                    onClick={() => {
                      setRemoving(at);
                    }}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <XIcon />
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      <RemoveLine
        at={removing}
        onRemove={(at) => {
          setRemoving(null);
          if (at !== null) {
            onRemove(at);
          }
        }}
      />
    </aside>
  );
};
