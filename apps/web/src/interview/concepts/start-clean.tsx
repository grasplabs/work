import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { Heading } from "@grasp-os/ui/components/heading";
import { Link } from "@grasp-os/ui/components/link";
import { Text } from "@grasp-os/ui/components/text";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { copy, ignore } from "./fixture.ts";

// CONCEPT ONLY: A's start, as Ruben shaped it (24 November), in his words
// (fixture.ts `copy.start`): the title on two lines, one short paragraph
// and the promises behind "How your answers are handled", the one button,
// and "Not right now" and "I'd rather skip this" as two quiet links at the
// foot. One decision on the screen: agree and start. Two text styles (the
// serif title, the body's words at one size), centred on one axis, calm:
// air round the title, one gap between blocks; the ways out apart at the
// foot of the screen.

const styles = stylex.create({
  // The page's room: the column under the header, the two quiet links at its foot.
  page: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    boxSizing: "border-box",
    paddingInline: { default: space["4"], [media.sm]: space["10"] },
    paddingBlockStart: { default: space["8"], [media.sm]: space["10"] },
    // The links at the foot stay clear of a phone's home bar.
    paddingBlockEnd: {
      default: `max(${space["4"]}, env(safe-area-inset-bottom))`,
      [media.sm]: `max(${space["8"]}, env(safe-area-inset-bottom))`,
    },
    textAlign: "center",
  },
  // The column: in the upper middle of the page, under the header, with presence, at a fixed
  // place from the top at every width, so the promises open under the trigger and nothing above
  // them moves. As wide as the page, so the title has a measure of its own.
  column: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    flexGrow: 1,
    gap: { default: space["8"], [media.lg]: space["10"] },
    width: "100%",
    paddingBlockStart: {
      default: "8vh",
      [media.sm]: "10vh",
      [media.lg]: "14vh",
    },
  },
  // The words under the title: the paragraph's measure (about 720px of text on a laptop).
  block: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["4"],
    width: "100%",
    maxWidth: { default: "26rem", [media.lg]: "45rem" },
  },
  // The title no wider than the page's room, so a line too long for it runs over, and is measured.
  title: { maxWidth: "100%" },
  // The title in two lines from a small laptop up, each line whole (the title steps a size down
  // before a line breaks, useTitleSize); on a phone one balanced run of words.
  titleLine: {
    display: { default: "inline", [media.sm]: "block" },
  },
  titleWhole: {
    whiteSpace: { default: null, [media.sm]: "nowrap" },
  },
  // The trigger on the centre axis, where it stays as the panel opens under it.
  centre: { justifySelf: "center" },
  // The promises: a list in the paragraph's words, its dots lined up at the start, the list as a
  // block centred under the trigger. Room above it on the list itself: on the panel it would show
  // while it is closed.
  list: {
    width: "fit-content",
    maxWidth: "100%",
    boxSizing: "border-box",
    marginBlock: 0,
    marginInline: "auto",
    paddingBlockStart: space["2"],
    paddingInlineStart: space["5"],
    listStyleType: "disc",
    textAlign: "start",
  },
  // The one button: the whole width on a phone, its own width on a wider window.
  agree: { width: { default: "100%", [media.sm]: "auto" } },
  // The two quiet ways out, side by side at the foot, apart.
  foot: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    columnGap: space["8"],
    rowGap: space["2"],
    paddingBlockStart: space["6"],
  },
  // A link's look on a button (these go nowhere, they answer): none of the button's own box, and
  // the words of the Text round it.
  bare: {
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
    fontWeight: "inherit",
  },
});

/** The title's sizes, from the largest: a step down before a line of it would break. */
const titleSizes = ["xl", "lg", "default"] as const;
const sizeNames: readonly string[] = titleSizes;

/**
 * The title's size: the largest at which each of its two lines stands whole in the room. A new
 * width of the room starts again from the largest; a line that runs over takes the next size down.
 * On a phone the lines are one run of words, which never runs over.
 */
const useTitleSize = () => {
  const [step, setStep] = useState(0);
  const firstLine = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const title = firstLine.current?.parentElement;
    const room = title?.parentElement;
    if (
      title === null ||
      title === undefined ||
      room === null ||
      room === undefined
    ) {
      return ignore;
    }
    // The room's width, not the title's: the title is only as wide as its words.
    let width = -1;
    const runsOver = (): boolean =>
      [...title.children].some((line) => line.scrollWidth > line.clientWidth);
    const fit = (): void => {
      const at = sizeNames.indexOf(title.dataset.size ?? "");
      if (room.clientWidth !== width && at > 0) {
        width = room.clientWidth;
        setStep(0);
        return;
      }
      width = room.clientWidth;
      if (runsOver()) {
        setStep(Math.min(at + 1, titleSizes.length - 1));
      }
    };
    // The room for a new width, the title for the new size it took.
    const watch = new ResizeObserver(fit);
    watch.observe(room);
    watch.observe(title);
    let current = true;
    // The serif arrives after the first measure, a little wider or narrower: measured again.
    const settle = async (): Promise<void> => {
      await document.fonts.ready;
      if (current) {
        width = -1;
        fit();
      }
    };
    void settle();
    return () => {
      current = false;
      watch.disconnect();
    };
  }, []);
  return {
    size: titleSizes[step] ?? "xl",
    // At the smallest size a line that still runs over wraps, rather than leave the window.
    whole: step < titleSizes.length - 1,
    firstLine,
  };
};

/** One of the two quiet ways out: the paragraph's words, underlined as a link is. */
const Quiet = ({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) => (
  <Text as="span" size="lg">
    <Link asChild>
      <button onClick={onClick} type="button" {...stylex.props(styles.bare)}>
        {children}
      </button>
    </Link>
  </Text>
);

/** A's start: one decision, centred. */
export const ConsentClean = ({
  altTitle,
  name,
  onAgree,
  onNotNow,
  onRatherNot,
}: {
  /** Ruben's alternative title, to compare (`&title=alt`). */
  altTitle: boolean;
  /** The person's name in the title (`&name=` tries a long one). */
  name: string;
  onAgree: () => void;
  onNotNow: () => void;
  onRatherNot: () => void;
}) => {
  const title = useTitleSize();
  return (
    <div {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.column)}>
        <Heading
          level={1}
          size={altTitle ? "xl" : title.size}
          style={styles.title}
        >
          {altTitle
            ? copy.start.titleAlt
            : copy.start.titleLines.map((line, at) => (
                <span
                  key={line}
                  ref={at === 0 ? title.firstLine : undefined}
                  {...stylex.props(
                    styles.titleLine,
                    title.whole && styles.titleWhole
                  )}
                >
                  {/* On a phone the two lines are one run of words: a space between them. */}
                  {at === 0 ? "" : " "}
                  {line.replace("{name}", name)}
                </span>
              ))}
        </Heading>
        <div {...stylex.props(styles.block)}>
          <Text size="lg">{copy.start.whoShort}</Text>
          <Collapsible fitContent>
            <CollapsibleTrigger size="lg" style={styles.centre} weight="normal">
              {copy.start.more}
            </CollapsibleTrigger>
            <CollapsibleContent asChild>
              <div>
                <Text as="div" size="lg">
                  <ul {...stylex.props(styles.list)}>
                    {copy.start.promises.map((promise) => (
                      <li key={promise}>{promise}</li>
                    ))}
                  </ul>
                </Text>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
        <Button onClick={onAgree} size="lg" style={styles.agree}>
          {copy.start.agree}
        </Button>
      </div>
      <div {...stylex.props(styles.foot)}>
        <Quiet onClick={onNotNow}>{copy.start.later}</Quiet>
        <Quiet onClick={onRatherNot}>{copy.start.decline}</Quiet>
      </div>
    </div>
  );
};
