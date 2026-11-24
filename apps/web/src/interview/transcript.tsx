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
import { Bubble, BubbleContent } from "@grasp-os/ui/components/bubble";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@grasp-os/ui/components/message";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@grasp-os/ui/components/message-scroller";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, XIcon } from "@grasp-os/ui/lib/icons";
import { fadeIn } from "@grasp-os/ui/lib/styles";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { useInterviewer } from "./kept.ts";
import { Marked } from "./talk.tsx";
import { useInterviewWords } from "./words.ts";

// The transcript, from the button top right (prototype
// `interview-view.tsx`, `Transcript`): the conversation as a normal chat,
// Damsko's MessageScroller of Messages, the interviewer at the start and
// them at the end, with what he marked in their words. It is no panel: it
// floats at the right side with nothing around it, fades in, and follows
// the newest line. It scrolls in itself; the page around it never does.
// Each line can be removed, by them alone, once confirmed (GRA-1897): only
// they read what was said, so only they can say which words should go.
// Whose a line is stays as core keeps it (`from: "stephen" | "person"`);
// only its side of the chat is read from it here.

export const transcriptId = "interview-transcript";

const styles = stylex.create({
  aside: {
    position: "absolute",
    zIndex: 1,
    top: 0,
    bottom: 0,
    insetInlineStart: { default: space["4"], [media.sm]: "auto" },
    insetInlineEnd: { default: space["4"], [media.sm]: space["10"] },
    display: "flex",
    flexDirection: "column",
    width: { default: "auto", [media.sm]: "22rem" },
  },
  note: { flexShrink: 0, paddingBlockEnd: space["2"] },
  thread: { display: "flex", flexGrow: 1, minHeight: 0 },
});

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

/** One line of the conversation: the interviewer's at the start, theirs at the end; one removed, as removed. */
const Line = ({
  line,
  onRemove,
}: {
  line: InterviewLine;
  onRemove: () => void;
}) => {
  const { t } = useLingui();
  const names = useInterviewWords().tag;
  const who = interviewerNames[useInterviewer()];
  const stephen = line.from === "stephen";
  const words = startOf(line.text);
  let said = (
    <Bubble align="end" variant="muted">
      <BubbleContent>
        <Marked marks={line.marks ?? []} names={names} text={line.text} />
      </BubbleContent>
    </Bubble>
  );
  if (line.removed === true) {
    said = (
      <Text color="muted" size="sm">
        {stephen ? t`A line of mine, removed.` : t`Removed.`}
      </Text>
    );
  } else if (stephen) {
    said = (
      <Bubble variant="ghost">
        <BubbleContent>{line.text}</BubbleContent>
      </Bubble>
    );
  }
  return (
    <Message
      align={stephen ? "start" : "end"}
      {...(stephen ? { "aria-label": who } : {})}
    >
      <MessageContent>
        {said}
        {line.removed === true ? null : (
          <MessageActions>
            <MessageAction
              aria-label={
                stephen
                  ? t`Remove ${who}’s line: ${words}`
                  : t`Remove your line: ${words}`
              }
              onClick={onRemove}
            >
              <Icon icon={XIcon} />
            </MessageAction>
          </MessageActions>
        )}
      </MessageContent>
    </Message>
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
        <div
          aria-live={alone ? "polite" : "off"}
          {...stylex.props(styles.thread)}
        >
          <MessageScrollerProvider autoScroll>
            <MessageScroller>
              <MessageScrollerViewport aria-label={t`Transcript`}>
                <MessageScrollerContent>
                  {lines.map((line, place) => (
                    // The conversation only grows: a line's place is what it is, and core removes it by it.
                    <MessageScrollerItem key={place} messageId={String(place)}>
                      <Line
                        line={line}
                        onRemove={() => {
                          setRemoving(place);
                        }}
                      />
                    </MessageScrollerItem>
                  ))}
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
