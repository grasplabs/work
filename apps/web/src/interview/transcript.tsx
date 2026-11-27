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

import { useGuideSaid } from "./guide-said.ts";
import { useInterviewer } from "./kept.ts";
import { useLoop } from "./loop.ts";
import type { LoopState } from "./loop.ts";
import { soundIsOn } from "./speech.ts";
import { ChatLine } from "./transcript-looks.tsx";
import type { Placed } from "./transcript-looks.tsx";

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
          <AlertDialogTitle>{t`Remove this message?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`The message is deleted now, and so is what I marked in it. What I wrote down from it is in what I read back to you at the end: take it out there, and it is deleted for good when our conversation is finished. This can’t be undone.`}
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

/** The lines where they stand, each told whether it starts a turn; `saying` is the place of his line as he says it. */
const placedOf = (
  lines: InterviewLine[],
  saying: number | null,
  guided: number
): Placed[] =>
  lines.map((line, place) => ({
    line,
    place,
    starts: place === 0 || lines[place - 1]?.from !== line.from,
    saying: place === saying,
    guide: place < guided,
  }));

/** Which line he is saying now, guide first: the last of his guide while it comes in, else his line after it. */
const sayingAt = (
  his: number | null,
  guided: number,
  guiding: boolean
): number | null => {
  if (his !== null) {
    return his + guided;
  }
  return guiding && guided > 0 ? guided - 1 : null;
};

/** As much of a line as is said, `count` characters, to the end of its last whole word. */
const saidOf = (text: string, count: number): string => {
  if (count >= text.length) {
    return text;
  }
  const cut = text.lastIndexOf(" ", count);
  return cut <= 0 ? "" : text.slice(0, cut);
};

/**
 * The transcript as far as he has said it: his line comes in word by word
 * with his voice, as on the stage. One the session told ahead of his voice
 * isn't there until he begins it; one he says that isn't written down yet
 * is there as far as he got.
 */
const saidSoFar = (
  lines: InterviewLine[],
  loop: Pick<LoopState, "doing" | "line" | "from" | "ahead" | "telling">
): { lines: InterviewLine[]; saying: number | null } => {
  const last = lines.at(-1);
  const his = last?.from === "stephen" && last.removed !== true ? last : null;
  if (
    loop.ahead !== null &&
    loop.ahead !== "" &&
    his?.text.endsWith(loop.ahead) === true
  ) {
    const said = saidOf(his.text, his.text.length - loop.ahead.length);
    return said === ""
      ? { lines: lines.slice(0, -1), saying: null }
      : {
          lines: [...lines.slice(0, -1), { ...his, text: said }],
          saying: lines.length - 1,
        };
  }
  if (
    loop.doing !== "speaking" ||
    loop.telling !== null ||
    loop.line === "" ||
    loop.from >= loop.line.length
  ) {
    return { lines, saying: null };
  }
  if (his?.text.endsWith(loop.line) === true) {
    const said = saidOf(
      his.text,
      his.text.length - loop.line.length + loop.from
    );
    return said === ""
      ? { lines: lines.slice(0, -1), saying: null }
      : {
          lines: [...lines.slice(0, -1), { ...his, text: said }],
          saying: lines.length - 1,
        };
  }
  const said = saidOf(loop.line, loop.from);
  if (said === "") {
    return { lines, saying: null };
  }
  return {
    lines: [...lines, { from: "stephen", text: said }],
    saying: lines.length,
  };
};

/** The rows of the transcript, each scrolled to as it comes. */
const Rows = ({
  lines,
  saying,
  guided,
  onRemove,
  onEdit,
}: {
  lines: InterviewLine[];
  saying: number | null;
  /** How many lines at the top are his guide's: they can't be removed. */
  guided: number;
  onRemove: (place: number) => void;
  onEdit: (place: number, text: string) => void;
}) => {
  const who = interviewerNames[useInterviewer()];
  const placed = placedOf(lines, saying, guided);
  return placed.map((one) => (
    // The conversation only grows: a line's place is what it is, and core removes it by it.
    <MessageScrollerItem key={one.place} messageId={String(one.place)}>
      <div
        // Whose it is, for what they just said to find its line here (heard.tsx).
        data-line-from={one.line.from}
        {...stylex.props(one.place > 0 && one.starts && styles.turn)}
      >
        <ChatLine
          onEdit={(text) => {
            onEdit(one.place, text);
          }}
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
  onEdit,
}: {
  open: boolean;
  /** The stage made way for it: it is what a screen reader hears the conversation from. */
  alone: boolean;
  lines: InterviewLine[];
  /** Removes the line at its place, for good. */
  onRemove: (at: number) => void;
  /** Puts their own line at its place right, in their words. */
  onEdit: (at: number, text: string) => void;
}) => {
  const { t } = useLingui();
  const [removing, setRemoving] = useState<number | null>(null);
  useHisNewLinesSaid(alone, lines);
  const loop = useLoop();
  const guide = useGuideSaid();
  if (!open) {
    return null;
  }
  const said = saidSoFar(lines, loop);
  // His guide stands first, on this page only: the conversation's places start after it.
  const before = guide.lines.length;
  const shown = {
    lines: [
      ...guide.lines.map((text): InterviewLine => ({ from: "stephen", text })),
      ...said.lines,
    ],
    saying: sayingAt(said.saying, before, guide.saying),
    guided: before,
  };
  return (
    <aside
      aria-label={t`Transcript`}
      id={transcriptId}
      {...stylex.props(styles.aside, fadeIn)}
    >
      {shown.lines.length === 0 ? (
        <Text color="muted">{t`Nothing said yet.`}</Text>
      ) : (
        <div {...stylex.props(styles.thread)}>
          <MessageScrollerProvider autoScroll>
            <MessageScroller>
              <MessageScrollerViewport aria-label={t`Transcript`}>
                <MessageScrollerContent>
                  <Rows
                    guided={shown.guided}
                    lines={shown.lines}
                    onEdit={(place, text) => {
                      onEdit(place - shown.guided, text);
                    }}
                    onRemove={(place) => {
                      setRemoving(place - shown.guided);
                    }}
                    saying={shown.saying}
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
