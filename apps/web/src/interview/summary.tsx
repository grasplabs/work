import { Button } from "@grasp-os/ui/components/button";
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import { fadeIn, visuallyHidden } from "@grasp-os/ui/lib/styles";
import { duration, media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { agreeToSummary, useLoop } from "./loop.ts";
import { wordsOf } from "./spoken.tsx";

// The one summary (the owner's ask, 2026-11-27): what Stephen says when he
// sums the conversation up, and nothing else. As he begins it his orb
// steps back and the summary takes the middle of the stage, large, in the
// serif of what Grasp says, its words coming in as he says them. What he
// says around it (that he gathers his notes, and his question at the end)
// stays out: those are his words to them, not the summary. Once he asked,
// the answer stands right under it: yes, or something to change, which
// they then say or type to him as anything else.

/** A summary longer than this stands a size smaller, so it still reads at a glance. */
const longChars = 260;

/** A sentence that leads in before the summary itself is short; one this long is the summary. */
const leadInChars = 45;

/** Where the sentences of `text` begin, in order. */
const sentenceStarts = (text: string): number[] => {
  const starts = [0];
  for (const match of text.matchAll(/[.!?…]\s+(?=\S)/gu)) {
    starts.push(match.index + match[0].length);
  }
  return starts;
};

/**
 * Where the summary in his line begins and ends: past the short sentences
 * he leads in with, and before the question he ends on.
 */
export const summaryIn = (line: string): { from: number; to: number } => {
  const starts = sentenceStarts(line);
  let from = 0;
  for (const [at, start] of starts.entries()) {
    const next = starts[at + 1] ?? line.length;
    if (next - start >= leadInChars || next === line.length) {
      from = start;
      break;
    }
  }
  let to = line.length;
  const last = starts.at(-1) ?? 0;
  if (last > from && line.trimEnd().endsWith("?")) {
    to = last;
  }
  return { from, to };
};

const styles = stylex.create({
  summary: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space["5"],
    width: "100%",
    maxWidth: "40rem",
    textAlign: "start",
    textWrap: "pretty",
  },
  word: {
    opacity: 1,
    filter: "blur(0)",
    transitionProperty: {
      default: "opacity, filter",
      [media.reducedMotion]: "none",
    },
    transitionDuration: "460ms",
    transitionTimingFunction: duration.ease,
  },
  unseen: { opacity: 0, filter: "blur(4px)" },
  answer: {
    display: "flex",
    flexWrap: "wrap",
    gap: space["3"],
    paddingBlockStart: space["2"],
  },
});

/** His summary, big in the middle; under it, once he asked, their answer to it. */
export const SpokenSummary = ({
  changing,
  onChange,
}: {
  /** They chose to change something: the answer waits until he sums it up again. */
  changing: boolean;
  onChange: () => void;
}) => {
  const { t } = useLingui();
  const loop = useLoop();
  const { summary } = loop;
  if (summary === null) {
    return null;
  }
  const { line, asked } = summary;
  const { from, to } = summaryIn(line);
  const text = line.slice(from, to).trim();
  // As far as he said it: while he says this line, its words come as he says them.
  const saying = loop.line === line && loop.doing === "speaking";
  const reached = saying ? loop.from - from : text.length;
  return (
    <section
      aria-labelledby="interview-summary"
      {...stylex.props(styles.summary, fadeIn)}
    >
      <Text color="muted" size="sm">
        <span id="interview-summary">{t`Summary`}</span>
      </Text>
      <Heading level={2} size={text.length > longChars ? "default" : "lg"}>
        <span aria-hidden="true">
          {wordsOf(text).map(({ word, start }) => (
            <span
              key={start}
              {...stylex.props(styles.word, start >= reached && styles.unseen)}
            >
              {word}
            </span>
          ))}
        </span>
        <span {...stylex.props(visuallyHidden)}>{saying ? "" : text}</span>
      </Heading>
      {asked && !changing && !saying ? (
        <div {...stylex.props(styles.answer, fadeIn)}>
          <Button
            onClick={() => {
              agreeToSummary();
            }}
            size="lg"
          >
            {t`Yes, that's right`}
          </Button>
          <Button onClick={onChange} size="lg" variant="outline">
            {t`Change something`}
          </Button>
        </div>
      ) : null}
    </section>
  );
};
