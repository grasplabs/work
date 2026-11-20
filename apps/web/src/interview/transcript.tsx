import type { InterviewLine } from "@grasp-os/shared/interview-links";
import { interviewerNames } from "@grasp-os/shared/onboarding";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { ChatMessage } from "../grasp/chat-message/index.ts";
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
  line: InterviewLine;
}

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
  const who = interviewerNames[useInterviewer()];
  if (!open) {
    return null;
  }
  const marked = lines.some(({ marks }) => (marks?.length ?? 0) > 0);
  const rows: Row[] = lines.map((line, at) => ({ id: String(at), line }));
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
            renderItem={({ line }) =>
              line.from === "stephen" ? (
                <ChatMessage from="agent" name={who}>
                  {line.text}
                </ChatMessage>
              ) : (
                <ChatMessage from="person">
                  <Marked
                    marks={line.marks ?? []}
                    names={names}
                    text={line.text}
                  />
                </ChatMessage>
              )
            }
          />
        </div>
      )}
    </aside>
  );
};
