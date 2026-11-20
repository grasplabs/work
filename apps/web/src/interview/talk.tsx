import { interviewPhases } from "@grasp-os/shared/interview-links";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import { interviewerNames } from "@grasp-os/shared/onboarding";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { arrive } from "../grasp/motion/arrive.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { Head, headSizes, useHead } from "./head.tsx";
import { useInterviewer } from "./kept.ts";
import { looks } from "./looks.ts";
import { useLoop } from "./loop.ts";
import { markedPieces } from "./progress.ts";
import { useSaidOf, voiceLevel } from "./speech.ts";
import { shownAs, SpokenText } from "./spoken.tsx";

// The conversation (prototype `interview-talk.tsx`, `Talk`): Stephen, or
// Claire when they chose her, in the middle, as large as the window leaves him, asking one thing, his
// words lighting up as he says them, his mouth warm with his voice; beside
// him a small sign of what he is doing. A line still being written grows
// in place as it comes. Then he waits for what they type in the box at the
// bottom.

const styles = stylex.create({
  // Room kept for his line, so the head doesn't move as it comes.
  room: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space5,
    width: "100%",
    minHeight: "9rem",
  },
  line: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    maxWidth: "32rem",
  },
  // What he marked in their words: underlined in the colour of what is agreed.
  mark: {
    color: "inherit",
    backgroundColor: "transparent",
    textDecorationLine: "underline",
    textDecorationColor: grasp.success,
    textDecorationThickness: "2px",
    textUnderlineOffset: "0.2em",
  },
});

/** How full he is printed: fuller as the interview goes on. */
export const fillOf = (phase: (typeof interviewPhases)[number]): number =>
  0.35 + (0.65 * interviewPhases.indexOf(phase)) / (interviewPhases.length - 1);

export const Talk = ({
  room,
  phase,
}: {
  room: number;
  phase: (typeof interviewPhases)[number];
}) => {
  const { t } = useLingui();
  const loop = useLoop();
  const interviewer = useInterviewer();
  const who = interviewerNames[interviewer];
  const { body, size } = useHead(room, headSizes.talking);
  const { title, rest } = shownAs(loop.line);
  const saidOf = useSaidOf(loop.line);
  // While he is about to say it, its words wait; once said, they rest.
  const said = loop.doing === "speaking" ? Math.max(0, saidOf) : -1;
  let label = t`${who}, asking.`;
  if (loop.doing === "listening") {
    label = t`${who}, listening.`;
  } else if (loop.doing === "thinking") {
    label = t`${who}, thinking.`;
  }
  return (
    <div {...stylex.props(looks.screen)}>
      <Head
        fill={fillOf(phase)}
        label={label}
        sign={loop.sign}
        size={size}
        voice={voiceLevel}
        who={interviewer}
      />
      <div aria-live="polite" ref={body} {...stylex.props(styles.room)}>
        {loop.line === "" ? null : (
          <div key={loop.saying} {...stylex.props(styles.line, arrive.in)}>
            <p {...stylex.props(looks.said)}>
              <SpokenText said={said} text={title} />
            </p>
            {rest === "" ? null : (
              <Text tone="muted">
                <SpokenText from={title.length + 1} said={said} text={rest} />
              </Text>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/** Something the person said, with what Stephen marked in it: each mark says what it is when pointed at. */
export const Marked = ({
  text,
  marks,
  names,
}: {
  text: string;
  marks: { quote: string; tag: FactTag }[];
  names: Record<FactTag, string>;
}) => (
  <>
    {markedPieces(text, marks).map((piece) =>
      piece.tag === null ? (
        <span key={piece.at}>{piece.text}</span>
      ) : (
        <mark
          key={piece.at}
          title={names[piece.tag]}
          {...stylex.props(styles.mark)}
        >
          {piece.text}
        </mark>
      )
    )}
  </>
);
