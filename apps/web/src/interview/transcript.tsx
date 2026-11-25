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
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@grasp-os/ui/components/message-scroller";
import { Text } from "@grasp-os/ui/components/text";
import { fadeIn } from "@grasp-os/ui/lib/styles";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { announce } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";

import { useInterviewer } from "./kept.ts";
import { soundIsOn } from "./speech.ts";
import {
  ChatLine,
  exchangesOf,
  QaExchange,
  QaLegend,
  ScriptLine,
  useTranscriptLook,
} from "./transcript-looks.tsx";
import type { Placed, TranscriptLook } from "./transcript-looks.tsx";

// The transcript, from the button top right (prototype
// `interview-view.tsx`, `Transcript`): the conversation as a normal chat,
// Damsko's MessageScroller of Messages, the interviewer at the start and
// them at the end, with what he marked in their words. It is no panel: it
// stands beside the stage with nothing around it, fades in, and follows
// the newest line. It scrolls in itself; the page around it never does.
// Each line can be removed, by them alone, once confirmed (GRA-1897): only
// they read what was said, so only they can say which words should go.
// Whose a line is stays as core keeps it (`from: "stephen" | "person"`);
// only its side of the chat is read from it here.

export const transcriptId = "interview-transcript";

const styles = stylex.create({
  // The column it is given: beside the stage on a wide window, in its place on a narrow one.
  aside: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    height: "100%",
    paddingBlockEnd: space["2"],
  },
  note: { flexShrink: 0, paddingBlockEnd: space["2"] },
  thread: { display: "flex", flexGrow: 1, minHeight: 0 },
  // A new turn stands apart from the one before; lines of one turn keep the scroller's own rhythm.
  turn: { paddingBlockStart: space["2"] },
});

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

/** The lines where they stand, each told whether it starts a turn. */
const placedOf = (lines: InterviewLine[]): Placed[] =>
  lines.map((line, place) => ({
    line,
    place,
    starts: place === 0 || lines[place - 1]?.from !== line.from,
  }));

/** The rows of the transcript in its look, each scrolled to as it comes. */
const Rows = ({
  look,
  lines,
  onRemove,
}: {
  look: TranscriptLook;
  lines: InterviewLine[];
  onRemove: (place: number) => void;
}) => {
  const who = interviewerNames[useInterviewer()];
  const placed = placedOf(lines);
  if (look === "c") {
    return exchangesOf(placed).map((exchange, index) => {
      const first = exchange.lines[0]?.place ?? index;
      return (
        // An exchange is known by its first line, whose place never changes.
        <MessageScrollerItem key={first} messageId={String(first)}>
          <QaExchange
            exchange={exchange}
            number={index + 1}
            onRemove={onRemove}
            who={who}
          />
        </MessageScrollerItem>
      );
    });
  }
  const Line = look === "b" ? ChatLine : ScriptLine;
  return placed.map((one) => (
    // The conversation only grows: a line's place is what it is, and core removes it by it.
    <MessageScrollerItem key={one.place} messageId={String(one.place)}>
      <div {...stylex.props(one.place > 0 && one.starts && styles.turn)}>
        <Line
          onRemove={() => {
            onRemove(one.place);
          }}
          placed={one}
          who={who}
        />
      </div>
    </MessageScrollerItem>
  ));
};

/**
 * While the transcript stands alone, the stage that reads his line out is
 * inert, and the transcript's log only says how many lines came: each new
 * line of his is said once, in his words. Not their own, which they know,
 * and not when it is heard, which would say it twice.
 */
const useHisNewLinesSaid = (alone: boolean, lines: InterviewLine[]): void => {
  const known = useRef(lines.length);
  useEffect(() => {
    const before = known.current;
    known.current = lines.length;
    if (!alone || soundIsOn()) {
      return;
    }
    for (const line of lines.slice(before)) {
      if (line.from === "stephen" && line.removed !== true) {
        announce(line.text);
      }
    }
  }, [alone, lines]);
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
  const look = useTranscriptLook();
  const interviewer = useInterviewer();
  useHisNewLinesSaid(alone, lines);
  if (!open) {
    return null;
  }
  const marked = lines.some(({ marks }) => (marks?.length ?? 0) > 0);
  return (
    <aside
      aria-label={t`Transcript`}
      id={transcriptId}
      {...stylex.props(styles.aside, fadeIn)}
    >
      {look === "c" && lines.length > 0 ? (
        <QaLegend who={interviewerNames[interviewer]} />
      ) : null}
      {marked ? (
        <div {...stylex.props(styles.note)}>
          <Text color="muted" size="xs">
            {t`What is marked is what I wrote down. You check it at the end.`}
          </Text>
        </div>
      ) : null}
      {lines.length === 0 ? (
        <Text color="muted">{t`Nothing said yet.`}</Text>
      ) : (
        <div {...stylex.props(styles.thread)}>
          <MessageScrollerProvider autoScroll>
            <MessageScroller>
              <MessageScrollerViewport aria-label={t`Transcript`}>
                <MessageScrollerContent>
                  <Rows
                    lines={lines}
                    look={look}
                    onRemove={(place) => {
                      setRemoving(place);
                    }}
                  />
                </MessageScrollerContent>
              </MessageScrollerViewport>
            </MessageScroller>
          </MessageScrollerProvider>
        </div>
      )}
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
