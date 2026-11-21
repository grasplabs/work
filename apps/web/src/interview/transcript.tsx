import type { InterviewLine } from "@grasp-os/shared/interview-links";
import { interviewerNames } from "@grasp-os/shared/onboarding";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../grasp/alert-dialog/index.ts";
import { ChatMessage, ChatMessageAction } from "../grasp/chat-message/index.ts";
import { Cross } from "../grasp/icons/index.ts";
import { arrive } from "../grasp/motion/arrive.ts";
import { Text } from "../grasp/text/index.ts";
import { Thread } from "../grasp/thread/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { useInterviewer } from "./kept.ts";
import { Marked } from "./talk.tsx";
import { useInterviewWords } from "./words.ts";

// The transcript, from the button top right (prototype
// `interview-view.tsx`, `Transcript`): the conversation as a normal chat,
// Grasp UI's Thread of ChatMessages, the interviewer on the left and them
// on the right, with what he marked in their words. It is no panel: it
// floats at the right side with nothing around it, fades in, and follows
// the newest line. It scrolls in itself; the page around it never does.
// Each line can be removed, by them alone, once confirmed (GRA-1897): only
// they read what was said, so only they can say which words should go.

export const transcriptId = "interview-transcript";

const styles = stylex.create({
  aside: {
    position: "absolute",
    zIndex: 1,
    top: 0,
    bottom: 0,
    insetInlineStart: { default: grasp.space4, [media.fromPhone]: "auto" },
    insetInlineEnd: { default: grasp.space4, [media.fromPhone]: grasp.space10 },
    display: "flex",
    flexDirection: "column",
    width: { default: "auto", [media.fromPhone]: "22rem" },
  },
  note: { flexShrink: 0, paddingBlockEnd: grasp.space2 },
  thread: { flexGrow: 1, minHeight: 0 },
});

/** A line of the conversation, as the thread knows it: its place is its id, as the conversation only grows. */
interface Row {
  id: string;
  /** Its place in the conversation, which core removes it by. */
  place: number;
  line: InterviewLine;
}

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
        <AlertDialogTitle>{t`Remove this line?`}</AlertDialogTitle>
        <AlertDialogDescription>
          {t`The line is deleted now, and so is what I marked in it. What I wrote down from it is in what I read back to you at the end: take it out there, and it is deleted for good when our conversation is finished. This can’t be undone.`}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel />
          <AlertDialogAction
            action={() => {
              onRemove(at);
            }}
            variant="danger"
          >
            {t`Remove`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
  const names = useInterviewWords().tag;
  const who = interviewerNames[useInterviewer()];
  if (!open) {
    return null;
  }
  const marked = lines.some(({ marks }) => (marks?.length ?? 0) > 0);
  const rows: Row[] = lines.map((line, place) => ({
    id: String(place),
    place,
    line,
  }));
  return (
    <aside
      aria-label={t`Transcript`}
      id={transcriptId}
      {...stylex.props(styles.aside, arrive.in)}
    >
      {marked ? (
        <div {...stylex.props(styles.note)}>
          <Text size="xs" tone="muted">
            {t`What is marked is what I wrote down. You check it at the end.`}
          </Text>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <Text tone="muted">{t`Nothing said yet.`}</Text>
      ) : (
        <div
          aria-live={alone ? "polite" : "off"}
          {...stylex.props(styles.thread)}
        >
          <Thread
            aria-label={t`Transcript`}
            items={rows}
            renderItem={({ place, line }) => {
              const stephen = line.from === "stephen";
              if (line.removed === true) {
                return (
                  <ChatMessage
                    from={stephen ? "agent" : "person"}
                    {...(stephen ? { name: who } : {})}
                  >
                    <Text element="span" tone="muted">
                      {stephen ? t`A line of mine, removed.` : t`Removed.`}
                    </Text>
                  </ChatMessage>
                );
              }
              const words = startOf(line.text);
              const remove = (
                <ChatMessageAction
                  aria-label={
                    stephen
                      ? t`Remove ${who}’s line: ${words}`
                      : t`Remove your line: ${words}`
                  }
                  icon={Cross}
                  onClick={() => {
                    setRemoving(place);
                  }}
                />
              );
              return stephen ? (
                <ChatMessage actions={remove} from="agent" name={who}>
                  {line.text}
                </ChatMessage>
              ) : (
                <ChatMessage actions={remove} from="person">
                  <Marked
                    marks={line.marks ?? []}
                    names={names}
                    text={line.text}
                  />
                </ChatMessage>
              );
            }}
          />
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
