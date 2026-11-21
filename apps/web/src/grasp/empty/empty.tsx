// Empty: what a list, a card or a page says when there is nothing in it, or when it could not
// load, from shadcn's (registry/bases/base/ui/empty.tsx), converted from Tailwind to StyleX and
// made Grasp's on Palermo's Empty & Error States: centred, quiet, a short title over one sentence,
// in one of three sizes.
//
// Since release step 6 its words and pictures are parts, as in shadcn's:
//
//   <Empty shape="rows">
//     <EmptyHeader>
//       <EmptyMedia picture="nothing" />
//       <EmptyTitle>No projects yet</EmptyTitle>
//       <EmptyDescription>Projects appear here once someone creates one.</EmptyDescription>
//     </EmptyHeader>
//     <EmptyContent><Button>New project</Button></EmptyContent>
//   </Empty>
//
// An error's empty EmptyMedia shows the alert icon, and its empty EmptyTitle "This did not load".
// The older shape below keeps working until step 9:
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
/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { createContext, isValidElement, useContext } from "react";
import type { ReactNode } from "react";

import { Alert, Icon } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { grasp } from "../tokens/tokens.stylex";
import { useWords } from "../words/words";
import { EmptyPictureDrawing } from "./pictures";
import type { EmptyPicture } from "./pictures";
import { EmptyShapeAround, EmptyShapePicture } from "./shape";
import type { EmptyShape } from "./shape";
import { emptyWords } from "./words";

export type { EmptyPicture } from "./pictures";
export type { EmptyShape } from "./shape";

/** What a caller may style: where it sits. */
export type EmptyLayoutStyle = LayoutStyle;

/** Every prop an Empty takes. */
export interface EmptyProps {
  /**
   * Its parts: an EmptyHeader (with EmptyMedia, EmptyTitle and EmptyDescription), then an
   * EmptyContent for the way on. In the older shape: one sentence, what will appear here and when.
   */
  children: ReactNode;
  /** @deprecated Use `EmptyTitle`. */
  title?: string;
  /** @deprecated Use `EmptyTitle.headingLevel`. */
  headingLevel?: 1 | 2 | 3 | 4;
  /** @deprecated Use `headingLevel`. */
  titleLevel?: 1 | 2 | 3 | 4;
  /**
   * `neutral`: there is nothing here. `danger`: it did not load, said to a screen reader at once.
   * @default "neutral"
   */
  tone?: "neutral" | "danger";
  /** @deprecated Use `tone`. */
  kind?: "empty" | "error";
  /**
   * An error's title and sentence are said to a screen reader as they appear (an alert), never its
   * actions. Set `false` where the page itself is the error, a route's error page, which is read
   * as any page is, not as a live update. Nothing is announced for `tone="neutral"`.
   * @default true
   */
  announce?: boolean;
  /**
   * `lg` stands for a whole list or page (at least 400px tall), `md` for a card or one tab (at
   * least 150px), `sm` for a small box, with no height of its own. `page`, `section` and `inline`
   * are the old names of the three, deprecated.
   * @default "md"
   */
  size?: "lg" | "md" | "sm" | "page" | "section" | "inline";
  /** @deprecated Use `EmptyMedia.icon`. */
  icon?: IconData;
  /** @deprecated Use `EmptyMedia.picture`. */
  picture?: EmptyPicture;
  /** @deprecated Use `EmptyMedia`, with the part as its children. */
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
  /** @deprecated Use `EmptyContent`. */
  action?: ReactNode;
  /** @deprecated Use `layout`. */
  style?: EmptyLayoutStyle;
  /** Layout only: where it sits. */
  layout?: EmptyLayoutStyle;
}

/** Every prop an EmptyHeader takes: the media, the title and the sentence, said together for an error. */
export interface EmptyHeaderProps {
  /** An EmptyMedia, an EmptyTitle and an EmptyDescription, in that order. */
  children: ReactNode;
}

/** Every prop an EmptyMedia takes: what stands above the title. Give one of the three, or none. */
export interface EmptyMediaProps {
  /** An icon, when it says what is missing faster: Inbox. From the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /**
   * A small drawing that tells the case apart at a glance, in place of the icon: `nothing` nothing
   * made yet, `search` nothing matches, `done` all cleared, `locked` no access, `offline` no
   * connection, `broken` it failed, `lost` no page at this address. A picture only: the title says
   * the same in words.
   */
  picture?: EmptyPicture;
  /**
   * A part of its own in the icon's place: the Working mark (or a Spinner) while the place is being
   * set up ("Setting up your workspace"), sized and centred as the icon is. Leave `icon` and
   * `picture` out with it. With none of the three, an error shows the alert icon, and nothing else
   * shows anything.
   */
  children?: ReactNode;
}

/** Every prop an EmptyTitle takes. */
export interface EmptyTitleProps {
  /**
   * A short title. Keep it for a page or a whole list, where the state stands alone; in a card or a
   * tab the sentence alone says it. An error always has one: leave it empty for "This did not load".
   */
  children?: ReactNode;
  /**
   * The title as a heading of this level, for when the state is the page or a section of it: `1`
   * on a not-found or error page, where the title is the page's h1; `2` or `3` in a section. The
   * look stays the same. Leave it out and the title is plain text, as the page's own heading names
   * the list.
   */
  headingLevel?: 1 | 2 | 3 | 4;
}

/** Every prop an EmptyDescription takes. */
export interface EmptyDescriptionProps {
  /** One sentence: what will appear here, and when ("Projects appear here once someone creates one."). */
  children: ReactNode;
}

/** Every prop an EmptyContent takes. */
export interface EmptyContentProps {
  /**
   * The way on, under the sentence: one Button, or a quiet second beside it ("New project";
   * "Clear the filter"; "Try again"). Its words say what it does.
   */
  children: ReactNode;
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

// ---- The parts (release step 6) --------------------------------------------------------------------

// What the root hands its parts: an error, said aloud, and standing at the head of the place.
const EmptyError = createContext(false);
const EmptySaid = createContext(false);
const EmptyTop = createContext(false);

/** What stands above the title: an icon, a drawing, or a part of its own. An error's alert icon by default. */
export const EmptyMedia = ({ icon, picture, children }: EmptyMediaProps) => {
  const error = useContext(EmptyError);
  const top = useContext(EmptyTop);
  // A picture stands where the icon would: one or the other, never both.
  const mark = picture ? undefined : (icon ?? (error ? Alert : undefined));
  return (
    <>
      {picture && <EmptyPictureDrawing picture={picture} start={top} />}
      <Mark mark={mark} media={children} error={error} top={top} />
    </>
  );
};

/** Children as a flat list: one child, or a list (as JSX writes several). */
const listOf = (children: ReactNode): ReactNode[] => [children].flat();
const isMedia = (child: ReactNode) =>
  isValidElement(child) && child.type === EmptyMedia;
/** A header's children: its media first, then its title and sentence. */
const splitMedia = (children: ReactNode) => {
  const all = listOf(children);
  return [all.filter(isMedia), all.filter((child) => !isMedia(child))] as const;
};

/**
 * The media, the title and the sentence. The media stands above, as in the older shape; the title
 * and the sentence are said to a screen reader together as they appear, for an error.
 */
export const EmptyHeader = ({ children }: EmptyHeaderProps) => {
  const said = useContext(EmptySaid);
  const top = useContext(EmptyTop);
  const [media, words] = splitMedia(children);
  return (
    <>
      {media}
      <div
        data-slot="empty-message"
        role={said ? "alert" : undefined}
        {...stylex.props(styles.message, top && styles.topWords)}
      >
        {words}
      </div>
    </>
  );
};

/** The short title. An error's is "This did not load" unless it is given words. */
export const EmptyTitle = ({ children, headingLevel }: EmptyTitleProps) => {
  const error = useContext(EmptyError);
  const { failed } = useWords("empty", emptyWords);
  const words = children ?? (error ? failed : undefined);
  const Title =
    headingLevel === undefined ? "p" : (`h${headingLevel}` as const);
  return words === undefined || words === null || words === "" ? null : (
    <Title {...stylex.props(styles.title)}>{words}</Title>
  );
};

/** The one sentence: what will appear here, and when. */
export const EmptyDescription = ({ children }: EmptyDescriptionProps) => (
  <p {...stylex.props(styles.sentence)}>{children}</p>
);

/** The way on, under the sentence. */
export const EmptyContent = ({ children }: EmptyContentProps) => {
  const top = useContext(EmptyTop);
  return <Way action={children} top={top} />;
};

const partTypes = new Set<unknown>([EmptyHeader, EmptyContent]);
/** Whether the children are the parts (the new shape) rather than the older shape's sentence. */
const holdsParts = (children: ReactNode) =>
  listOf(children).some(
    (child) => isValidElement(child) && partTypes.has(child.type)
  );

/** The older shape's words, drawn from the Empty's own props (until release step 9). */
const OlderWords = ({
  picture,
  mark,
  part,
  error,
  top,
  heading,
  titleLevel,
  said,
  action,
  children,
}: {
  picture: EmptyPicture | undefined;
  mark: IconData | undefined;
  part: ReactNode;
  error: boolean;
  top: boolean;
  heading: string;
  titleLevel: EmptyProps["titleLevel"];
  said: boolean;
  action: ReactNode;
  children: ReactNode;
}) => (
  <>
    {picture && <EmptyPictureDrawing picture={picture} start={top} />}
    <Mark mark={mark} media={part} error={error} top={top} />
    <Message heading={heading} titleLevel={titleLevel} said={said} top={top}>
      {children}
    </Message>
    <Way action={action} top={top} />
  </>
);

/** The kind by its new name (`tone`), else the deprecated old one (the breaking release's step 1). */
const kindOf = (
  tone: EmptyProps["tone"],
  kind: "empty" | "error" | undefined
): "empty" | "error" => {
  if (tone !== undefined) {
    return tone === "danger" ? "error" : "empty";
  }
  return kind ?? "empty";
};

/** The size by its new name, else its old one: `lg` is `page`, `md` `section`, `sm` `inline`. */
const sizes = {
  lg: "page",
  md: "section",
  sm: "inline",
  page: "page",
  section: "section",
  inline: "inline",
} as const;
const sizeOf = (size: EmptyProps["size"]) => sizes[size ?? "md"];

export const Empty = ({
  children,
  title,
  titleLevel: titleLevelDeprecated,
  headingLevel: titleLevel = titleLevelDeprecated,
  kind: kindDeprecated,
  tone,
  announce = true,
  size: sizeGiven,
  icon,
  picture,
  media: part,
  shape,
  place = "middle",
  action,
  style: styleProp,
  layout,
}: EmptyProps) => {
  const kind = kindOf(tone, kindDeprecated);
  const size = sizeOf(sizeGiven);
  const { failed } = useWords("empty", emptyWords);
  const error = kind === "error";
  const top = place === "top";
  const behind = shape !== undefined && !top;
  // An error always says so in a title, so it is never read as an empty list.
  const heading = title ?? (error ? failed : "");
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
        {holdsParts(children) ? (
          <EmptyError value={error}>
            <EmptySaid value={error && announce}>
              <EmptyTop value={top}>{children}</EmptyTop>
            </EmptySaid>
          </EmptyError>
        ) : (
          <OlderWords
            picture={picture}
            mark={mark}
            part={part}
            error={error}
            top={top}
            heading={heading}
            titleLevel={titleLevel}
            said={error && announce}
            action={action}
          >
            {children}
          </OlderWords>
        )}
      </div>
      {/* After the words in the page: the words are what is met first. */}
      <Place shape={shape} top={top} />
    </div>
  );
};
