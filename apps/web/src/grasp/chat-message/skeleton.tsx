// ChatMessageSkeleton: the shape of a message while an old chat loads, made of Skeleton's lines, at
// the message's own widths. A person's: a bubble at the end, as wide as a short question. The
// agent's: its name, then lines of words, the last one short. Thread's `loading` draws pairs of them;
// a page that loads one message on its own may draw one.
//
//   <ChatMessageSkeleton from="person" />
//   <ChatMessageSkeleton from="agent" lines={3} />
//
// It says nothing: Skeleton is hidden from screen readers, and the region it stands in carries
// `aria-busy` and says once what is loading (Thread does both). Every value is a token (src/tokens).
import * as stylex from "@stylexjs/stylex";

import { Skeleton } from "../skeleton";
import { grasp } from "../tokens/tokens.stylex";

/** Every prop a ChatMessageSkeleton takes. */
export interface ChatMessageSkeletonProps {
  /** Whose message it stands for: the person's, a bubble at the end, or the agent's, lines of words. */
  from: "person" | "agent";
  /**
   * How many lines of words it stands for, at most eight. A person's bubble grows with them, as a
   * real one does.
   * @default 1 for a person, 3 for the agent
   */
  lines?: number;
}

const styles = stylex.create({
  // The message's own column: the same gap as ChatMessage's, so a real message takes the same room.
  root: {
    display: "grid",
    gap: grasp.space2,
    minWidth: 0,
  },
  person: {
    justifyItems: "end",
  },
  // A person's bubble: as tall as its lines with the bubble's room round them.
  bubble: (lines: number) => ({
    height: `calc(${lines} * ${grasp.textMdLine} + 2 * ${grasp.space3})`,
  }),
  // A short question is about half the room; a longer one most of it, never past a bubble's width.
  short: { width: `min(${grasp.chatBubbleWidth}, 55%)` },
  long: { width: `min(${grasp.chatBubbleWidth}, 80%)` },
  // The agent's name, a short word.
  name: { width: grasp.space24 },
  words: { display: "grid", minWidth: 0 },
  line: { width: "100%" },
  last: { width: "60%" },
});

/** The lines' keys: the lines are the same each time, in the same order. At most eight. */
const LINES = ["a", "b", "c", "d", "e", "f", "g", "h"];

/** One message's shape while it loads: a person's bubble, or the agent's name and lines. */
export const ChatMessageSkeleton = ({
  from,
  lines,
}: ChatMessageSkeletonProps) => {
  if (from === "person") {
    return (
      <div
        data-slot="chat-message-skeleton"
        data-from="person"
        {...stylex.props(styles.root, styles.person)}
      >
        <Skeleton
          variant="block"
          layout={[
            styles.bubble(Math.max(1, lines ?? 1)),
            (lines ?? 1) > 1 ? styles.long : styles.short,
          ]}
        />
      </div>
    );
  }
  const count = Math.min(LINES.length, Math.max(1, lines ?? 3));
  return (
    <div
      data-slot="chat-message-skeleton"
      data-from="agent"
      {...stylex.props(styles.root)}
    >
      <Skeleton text="sm" layout={styles.name} />
      <div {...stylex.props(styles.words)}>
        {LINES.slice(0, count).map((key, line) => (
          <Skeleton
            key={key}
            text="md"
            layout={line === count - 1 && count > 1 ? styles.last : styles.line}
          />
        ))}
      </div>
    </div>
  );
};
