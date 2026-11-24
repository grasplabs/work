import type { FactTag } from "@grasp-os/shared/interview-turn";
import { colors } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

import { markedPieces } from "./progress.ts";

// What Stephen marked in what someone said: underlined in the colour of
// what is agreed, each mark saying what it is when pointed at. In their
// words over the box and in the transcript.

const styles = stylex.create({
  mark: {
    color: "inherit",
    backgroundColor: "transparent",
    textDecorationLine: "underline",
    textDecorationColor: colors.success,
    textDecorationThickness: "2px",
    textUnderlineOffset: "0.2em",
  },
});

/** Something the person said, with what Stephen marked in it. */
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
