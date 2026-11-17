// Empty: what a list, a card or a page says when there is nothing in it, or when it could not
// load, from shadcn's (registry/bases/base/ui/empty.tsx), converted from Tailwind to StyleX and
// made Grasp's on Palermo's Empty & Error States: centred, quiet, a short title over one sentence,
// in one of three sizes.
//
//   <Empty title="No projects yet">Projects appear here once someone creates one.</Empty>
//   <Empty size="section">Comments will appear here.</Empty>             no title in a card
//   <Empty kind="error">The projects did not load.</Empty>               says so, out loud
//   <Empty size="page" titleLevel={1} picture="lost" title="No page here">…</Empty>   a page's h1
//   <Empty kind="error" announce={false} titleLevel={1} title="…">…</Empty>   a route's error page
//   <Empty shape="rows" title="No projects yet" action={<Button>New project</Button>}>…</Empty>
//
// `shape` draws what will stand here (a list's rows, a grid's cards, a chart's bars, a thread's
// bubbles) faint in the system's dither behind the words, so the place keeps its shape and the
// first item arrives into it. `picture` is a small drawing that tells the case apart (nothing yet,
// nothing found, all done, no access, offline, it failed). `action` is the one way on.
//
// "Nothing here" and "it did not load" are kept apart on purpose: telling someone a list is empty
// when its request failed is the one answer that is wrong. Every value is a token (src/tokens).
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Alert, Icon } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { grasp } from "../tokens/tokens.stylex";
import { EmptyPictureDrawing } from "./pictures";
import type { EmptyPicture } from "./pictures";
import { EmptyShapeAround, EmptyShapePicture } from "./shape";
import type { EmptyShape } from "./shape";

export type { EmptyPicture } from "./pictures";
export type { EmptyShape } from "./shape";

/** What a caller may style: where it sits. */
export type EmptyLayoutStyle = LayoutStyle;

/** Every prop an Empty takes. */
export interface EmptyProps {
  /** One sentence: what will appear here, and when ("Projects appear here once someone creates one."). */
  children: ReactNode;
  /**
   * A short title. Keep it for a page or a whole list, where the state stands alone; in a card or a
   * tab the sentence alone says it. An error always has one: its own, unless you give it another.
   */
  title?: string;
  /**
   * The title as a heading of this level, for when the state is the page or a section of it: `1`
   * on a not-found or error page, where the title is the page's h1; `2` or `3` in a section. The
   * look stays the same. Leave it out and the title is plain text, as the page's own heading names
   * the list.
   */
  titleLevel?: 1 | 2 | 3 | 4;
  /**
   * `empty`: there is nothing here. `error`: it did not load, said to a screen reader at once.
   * @default "empty"
   */
  kind?: "empty" | "error";
  /**
   * An error's title and sentence are said to a screen reader as they appear (an alert), never its
   * actions. Set `false` where the page itself is the error, a route's error page, which is read
   * as any page is, not as a live update. Nothing is announced for `kind="empty"`.
   * @default true
   */
  announce?: boolean;
  /**
   * `page` stands for a whole list or page (at least 400px tall), `section` for a card or one tab
   * (at least 150px), `inline` for a small box, with no height of its own.
   * @default "section"
   */
  size?: "page" | "section" | "inline";
  /** An icon above the title, when it says what is missing faster: Inbox. From the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /**
   * A small drawing above the title that tells the case apart at a glance, in place of the icon:
   * `nothing` nothing made yet, `search` nothing matches, `done` all cleared, `locked` no access,
   * `offline` no connection, `broken` it failed, `lost` no page at this address. A picture only: the title says the same in words.
   */
  picture?: EmptyPicture;
  /**
   * In the icon's place, a part of its own: the Working mark (or a Spinner) while the place is
   * being set up ("Setting up your workspace"), sized and centred as the icon is. The Working mark
   * stands still with reduced motion. Leave `icon` and `picture` out with it.
   */
  media?: ReactNode;
  /**
   * What will stand here, drawn faint behind the words so the place keeps its shape: `rows` for a
   * list or a table, `cards` for a grid, `chart` for bars, `thread` for a conversation. A picture
   * only: a screen reader does not meet it. Leave it out in a small box.
   */
  shape?: EmptyShape;
  /**
   * Where the words stand. `middle`: centred in the place, the picture of the place round them.
   * `top`: at the head of the place, from its start edge, where the first item will land, with
   * the rows to come drawn under them. Use `top` for a list or a table that will fill downwards.
   * @default "middle"
   */
  place?: "middle" | "top";
  /**
   * The way on, under the sentence: one Button, or a quiet second beside it ("New project";
   * "Clear the filter"; "Try again"). Its words say what it does.
   */
  action?: ReactNode;
  /** Layout only: where it sits. */
  style?: EmptyLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: EmptyLayoutStyle;
}

const styles = stylex.create({
  box: {
    [iconVars.size]: grasp.iconMd,
    [iconVars.stroke]: grasp.iconStroke,
    display: "grid",
    justifyItems: "center",
    alignContent: "center",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    // Room at the sides too, so its words never touch the edges of a narrow list.
    paddingInline: grasp.space4,
    textAlign: "center",
    fontFamily: grasp.fontSans,
  },
  // With a picture of the place behind them, the words stand over it.
  // With a picture of the place round them, the words stand in the middle cell of three by three
  // and the picture is drawn in the cells beside it (EmptyShapeAround), never in theirs.
  shaped: {
    position: "relative",
    isolation: "isolate",
    gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)",
    gridTemplateRows: `minmax(${grasp.space8}, 1fr) auto minmax(${grasp.space8}, 1fr)`,
    justifyItems: "stretch",
    alignContent: "stretch",
    paddingInline: 0,
  },
  // A chart stands on the place's floor and has nothing above the words: they sit at its head, over
  // the bars, rather than over an empty band as tall as the chart (at 390 it was 150px of nothing).
  shapedChart: { gridTemplateRows: "0 auto minmax(0, 1fr)" },
  // The words' cell is their clearing: their own box and a margin of a line above and below and
  // 16px at each side, where nothing of the picture is drawn.
  over: {
    position: "relative",
    zIndex: 1,
    gridRow: 2,
    gridColumn: 2,
    boxSizing: "content-box",
    paddingBlock: grasp.space5,
    paddingInline: grasp.space4,
  },
  // At the head of the place: the words from the start edge, where the first item will land.
  top: {
    justifyItems: "stretch",
    alignContent: "start",
    textAlign: "start",
    paddingBlock: grasp.space5,
  },
  topWords: { justifyItems: "start" },
  startAction: { justifyContent: "flex-start" },
  // The rows to come, under the words, to the place's edges and fading at its foot.
  under: {
    position: "relative",
    height: 180,
    marginTop: grasp.space5,
    marginInline: `calc(-1 * ${grasp.space4})`,
  },
  action: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: grasp.space2,
    marginTop: grasp.space4,
  },
  page: { minHeight: grasp.emptyPage },
  section: { minHeight: grasp.emptySection },
  inline: { padding: grasp.space4 },
  // The title and sentence together: the part said out loud for an error, never its actions. Its
  // own grid, at the words' gap, so the lines stand where they did before it held them.
  message: { display: "grid", rowGap: grasp.space2, minWidth: 0 },
  words: {
    display: "grid",
    rowGap: grasp.space2,
    maxWidth: grasp.emptyMeasure,
    // A word longer than the measure breaks; common words are not hyphenated at this short width.
    overflowWrap: "anywhere",
  },
  icon: {
    display: "inline-flex",
    justifySelf: "center",
    marginBottom: grasp.space3,
    color: grasp.muted,
  },
  iconStart: { justifySelf: "start" },
  // A part in the icon's place keeps the icon's box: its height and width, centred in it.
  media: {
    alignItems: "center",
    justifyContent: "center",
    width: grasp.iconMd,
    height: grasp.iconMd,
  },
  iconError: {
    color: grasp.danger,
  },
  title: {
    // Its own tracking: a host page's heading rules never reach it.
    letterSpacing: grasp.trackingUi,
    margin: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.muted,
    textWrap: "balance",
  },
  sentence: {
    margin: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.quiet,
    textWrap: "pretty",
  },
});

/** The icon above the title, when there is no picture. */
const Mark = ({
  mark,
  media: part,
  error,
  top,
}: {
  mark: IconData | undefined;
  media: ReactNode;
  error: boolean;
  top: boolean;
}) => {
  // A part of its own in the icon's place (the Working mark): the icon's box, centred, its own
  // colours; its words, if any, are its own.
  if (part !== undefined && part !== null && part !== false) {
    return (
      <span
        data-slot="empty-media"
        {...stylex.props(styles.icon, styles.media, top && styles.iconStart)}
      >
        {part}
      </span>
    );
  }
  return mark ? (
    <span
      aria-hidden="true"
      {...stylex.props(
        styles.icon,
        error && styles.iconError,
        top && styles.iconStart
      )}
    >
      <Icon icon={mark} />
    </span>
  ) : null;
};

/** The way on, under the sentence. */
const Way = ({ action, top }: { action: ReactNode; top: boolean }) =>
  action === undefined || action === null || action === false ? null : (
    <div
      data-slot="empty-action"
      {...stylex.props(styles.action, top && styles.startAction)}
    >
      {action}
    </div>
  );

/**
 * The title and the sentence. A failure is said when it replaces what was loading: these two, not
 * the way on (read again on each render otherwise). Nothing-here is read where it stands.
 */
const Message = ({
  heading,
  titleLevel,
  said,
  top,
  children,
}: {
  heading: string;
  titleLevel: EmptyProps["titleLevel"];
  said: boolean;
  top: boolean;
  children: ReactNode;
}) => {
  const Title = titleLevel === undefined ? "p" : (`h${titleLevel}` as const);
  return (
    <div
      data-slot="empty-message"
      role={said ? "alert" : undefined}
      {...stylex.props(styles.message, top && styles.topWords)}
    >
      {heading !== "" && (
        <Title {...stylex.props(styles.title)}>{heading}</Title>
      )}
      <p {...stylex.props(styles.sentence)}>{children}</p>
    </div>
  );
};

/** The picture of the place: round the words, or under them when they stand at its head. */
const Place = ({
  shape,
  top,
}: {
  shape: EmptyShape | undefined;
  top: boolean;
}) => {
  if (!shape) {
    return null;
  }
  if (!top) {
    return <EmptyShapeAround shape={shape} />;
  }
  return (
    <div {...stylex.props(styles.under)}>
      <EmptyShapePicture shape={shape} whole />
    </div>
  );
};

export const Empty = ({
  children,
  title,
  titleLevel,
  kind = "empty",
  announce = true,
  size = "section",
  icon,
  picture,
  media: part,
  shape,
  place = "middle",
  action,
  style: styleProp,
  layout,
}: EmptyProps) => {
  const error = kind === "error";
  const top = place === "top";
  const behind = shape !== undefined && !top;
  // An error always says so in a title, so it is never read as an empty list.
  const heading = title ?? (error ? "This did not load" : "");
  // A picture stands where the icon would: one or the other, never both.
  const mark = picture ? undefined : (icon ?? (error ? Alert : undefined));
  return (
    <div
      data-slot="empty"
      data-kind={kind}
      data-place={place}
      {...stylex.props(
        styles.box,
        styles[size],
        behind && styles.shaped,
        behind && shape === "chart" && styles.shapedChart,
        top && styles.top,
        layout ?? styleProp
      )}
    >
      <div
        {...stylex.props(
          styles.words,
          behind && styles.over,
          top && styles.topWords
        )}
      >
        {picture && <EmptyPictureDrawing picture={picture} start={top} />}
        <Mark mark={mark} media={part} error={error} top={top} />
        <Message
          heading={heading}
          titleLevel={titleLevel}
          said={error && announce}
          top={top}
        >
          {children}
        </Message>
        <Way action={action} top={top} />
      </div>
      {/* After the words in the page: the words are what is met first. */}
      <Place shape={shape} top={top} />
    </div>
  );
};
