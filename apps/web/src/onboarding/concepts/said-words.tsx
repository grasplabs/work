import { Text } from "@grasp-os/ui/components/text";

import { useSaid } from "../../voice/voice.ts";

/** Each word of `text` and where it starts and ends in it. */
const wordsOf = (text: string) => {
  const words: { word: string; start: number; end: number }[] = [];
  for (const match of text.matchAll(/\S+\s*/gu)) {
    words.push({
      word: match[0],
      start: match.index,
      end: match.index + match[0].trimEnd().length,
    });
  }
  return words;
};

/**
 * `text`, part of the spoken `line` from `from`: while it is said, the
 * words said stand in ink and those to come are subtle; before and
 * after, all of it is muted, as a step's sentence is. Only Text's own
 * colours, so no colour of the page's.
 */
export const SaidWords = ({
  line,
  from,
  text,
  size = "lg",
}: {
  line: string;
  from: number;
  text: string;
  size?: "default" | "lg";
}) => {
  const said = useSaid(line);
  return (
    <>
      {wordsOf(text).map(({ word, start, end }) => {
        let color: "default" | "muted" | "subtle" = "muted";
        if (said >= 0) {
          color = said >= from + end ? "default" : "subtle";
        }
        return (
          <Text as="span" color={color} key={start} size={size}>
            {word}
          </Text>
        );
      })}
    </>
  );
};
